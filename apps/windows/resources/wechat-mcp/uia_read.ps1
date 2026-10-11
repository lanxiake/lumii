param([int]$Hwnd, [string]$Out, [switch]$All)
# Read WeChat's UI Automation tree: live state AND live geometry.
#
# Why this exists (measured 2026-10-09): PrintWindow hands back the window's LAST RENDERED
# surface. While the WeChat window is covered by another window Qt stops repainting it, so
# every read_ui() frame is a stale picture - the session list order, the previews, the
# timestamps and every coordinate in it are from minutes ago. Working off that frame, the
# sender clicked old row positions and then failed its own target check ("target unconfirmed").
# The accessibility tree comes from the app's model, so it stays correct while the window is
# covered, minimized, or hidden to the tray - and it carries exact text (no OCR errors) plus a
# BoundingRectangle per item to click at.
#
# Emits tab-separated lines, all coordinates in SCREEN space (caller subtracts the window
# origin to get the layout space post_click() wants):
#   WIN   <l> <t> <w> <h>
#   ITEM  <automationId> <x> <y> <w> <h> <isSelected 0/1> <name>
#   SITEM <class_name> <x> <y> <w> <h> <name>     <- search-results dropdown rows
#   HEADER <current chat name>
#   EDIT  <automationId> <x> <y> <w> <h> <name>
#   INPUT <composer text>            <- what is typed in the message box RIGHT NOW
#   MLIST <x> <y> <w> <h>
#   BTN   <automationId> <x> <y> <w> <h> <name>
#   ERR   <reason>
#
# -All additionally dumps EVERY descendant as CTL lines, carrying the NativeWindowHandle:
#   CTL   <controlType> <automationId> <hwnd> <x> <y> <w> <h> <name>
# It exists for the file dialog the attachment path drives. That #32770 exposes its controls
# through the MSAA bridge, so they arrive as ControlType.Pane - they are NOT in the EDIT/BTN
# lists above. And unlike the main window, they must be driven by native handle (WM_SETTEXT /
# BM_CLICK) rather than by click coordinates: no foreground is taken, so no real mouse.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$W = [System.Windows.Automation.TreeWalker]
$lines = @()
function RectStr($e) {
  # BoundingRectangle is NaN for off-screen / virtualized items, and [int]NaN THROWS. Unhandled,
  # one such item aborts the whole enumeration (measured on the file dialog's virtualized list).
  try {
    $r = $e.Current.BoundingRectangle
    return ("{0}`t{1}`t{2}`t{3}" -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
  } catch { return "0`t0`t0`t0" }
}
function One($root, $id) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
  return $root.FindFirst($TS::Descendants, $c)
}
function Clean($s) { if ($null -eq $s) { return '' }; return $s.Replace("`r", ' ').Replace("`n", ' ') }
function OneBySuffix($root, $suffix) {
  # 兜底查找：微信的 AutomationId 是**整条点分路径**
  # （`content_view.top_content_view....current_chat_name_label`），中间多包一层容器就整个失配——
  # 而这条路径正是发送前「头部双印证」用的锚点，失配即整条发送链废掉。
  # 退一步只认**尾段**：`id -eq 尾段` 或 `id 以 ".尾段" 结尾`。找不到才扫全树（慢，所以只做兜底）。
  $all = $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    # 必须强转成字符串：AutomationId 为 null 时 `AId` 返回 $null，
    # 直接 `$null.EndsWith(...)` 会抛「不能对 Null 值表达式调用方法」把整次读取废掉（踩过）
    $id = [string](AId $e)
    if ($id -eq $suffix -or $id.EndsWith("." + $suffix)) { return $e }
  }
  return $null
}
function AId($e) { try { return $e.Current.AutomationId } catch { return '' } }
try {
  $root = $AE::FromHandle([IntPtr]$Hwnd)
  if (-not $root) { $lines += "ERR`tno_root"; [System.IO.File]::WriteAllLines($Out, $lines, [System.Text.UTF8Encoding]::new($false)); exit 0 }
  $lines += ("WIN`t" + (RectStr $root))
  $cw = $W::ControlViewWalker

  # session list: one ListItem per conversation, name carries preview + time
  $lst = One $root "session_list"
  if ($lst) {
    $kid = $cw.GetFirstChild($lst)
    while ($kid -ne $null) {
      $sel = ''
      try { $sel = $(if ($kid.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { '1' } else { '0' }) } catch {}
      $lines += ("ITEM`t{0}`t{1}`t{2}" -f (AId $kid), (RectStr $kid), $sel + "`t" + (Clean $kid.Current.Name))
      $kid = $cw.GetNextSibling($kid)
    }
  }
  # No session list is NOT an error: the same reader doubles as a dialog inspector
  # (the file picker the attachment path drives is a plain #32770 with Edit + Button).

  # search-results dropdown (WeChat 4.x): AutomationId "search_list", ControlType List.
  # The sender reads this to pick the EXACT target row instead of pressing Enter on whatever
  # WeChat ranked first - a contact whose WeChat ID contains the query can outrank the matching
  # group (measured 2026-10-11: searching "321" listed contact "cruel" / wxid crue1321 above the
  # group "321"). class_name separates real chat rows (mmui::SearchContentCellView) from section
  # headers and feature rows (mmui::XTableCell), so the picker can ignore the latter.
  #   SITEM <class_name> <x> <y> <w> <h> <name>
  $sr = One $root "search_list"
  if ($sr) {
    $kid = $cw.GetFirstChild($sr)
    while ($kid -ne $null) {
      $cls = ''
      try { $cls = [string]$kid.Current.ClassName } catch {}
      $lines += ("SITEM`t{0}`t{1}`t{2}" -f $cls, (RectStr $kid), (Clean $kid.Current.Name))
      $kid = $cw.GetNextSibling($kid)
    }
  }

  # which conversation is actually open right now
  # 先认完整路径（快），失配再按尾段兜底（见 OneBySuffix 的说明）
  $lbl = One $root "content_view.top_content_view.title_h_view.left_v_view.left_content_v_view.left_ui_.big_title_line_h_view.current_chat_name_label"
  if (-not $lbl) { $lbl = OneBySuffix $root "current_chat_name_label" }
  if ($lbl) { $lines += ("HEADER`t" + (Clean $lbl.Current.Name)) } else { $lines += "HEADER`t" }

  # text boxes: the search box (name <search>) and the message input
  $ec = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  $edits = $root.FindAll($TS::Descendants, $ec)
  foreach ($e in $edits) { $lines += ("EDIT`t{0}`t{1}`t{2}" -f (AId $e), (RectStr $e), (Clean $e.Current.Name)) }

  # the message composer's current text. It IS in the tree, as an Edit with
  # AutomationId chat_input_field - the older note claiming "the only Edit is the search box" was
  # wrong, it came from a ControlType scan that never surfaced this one. ValuePattern gives the
  # exact text, so a send can READ the box and refuse when it is not what we expect, instead of
  # blindly sending whatever was left in it.
  $inp = One $root "chat_input_field"
  if ($inp) {
    $v = ''
    try { $v = $inp.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    $lines += ("INPUT`t" + (Clean $v))
  }

  # message list + named buttons (send button lives here)
  $ml = One $root "chat_message_list"
  if ($ml) { $lines += ("MLIST`t" + (RectStr $ml)) }
  $bc = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $btns = $root.FindAll($TS::Descendants, $bc)
  foreach ($b in $btns) {
    $nm = Clean $b.Current.Name
    if ($nm -ne '') { $lines += ("BTN`t{0}`t{1}`t{2}" -f (AId $b), (RectStr $b), $nm) }
  }
  if ($All) {
    # Two traps here, both measured, both SILENT (no output, no error):
    # 1) Do NOT name the collection $all: PowerShell variable names are case-insensitive, so it
    #    collides with the $All switch - assigning to it tries to coerce into SwitchParameter
    #    and throws.
    # 2) Keep this file pure ASCII. PS 5.1 reads a BOM-less UTF-8 .ps1 as GBK; a Chinese comment
    #    decodes into mojibake that ends in a backtick, and the backtick escapes the newline,
    #    eating the NEXT line. Measured: it ate the FindAll assignment below, leaving $desc null
    #    - and FindAll with a null condition returns null instead of throwing, so the whole
    #    block just quietly emitted nothing.
    # Wrapped in its own try: -All is an ADDITION, it must never take the whole read down. A
    # dialog that is still being built throws from FindAll (an "unrecognized error"),
    # and an ERR line makes the Python reader discard everything, including the WIN line.
    try {
    $any = [System.Windows.Automation.Condition]::TrueCondition
    $desc = $root.FindAll($TS::Descendants, $any)
    foreach ($e in $desc) {
      # Per-item guard on purpose: elements go stale mid-enumeration and one throw here must not
      # abort the rest, nor bubble to the outer catch (an ERR line makes the reader give up).
      try {
        $ct = $e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $nwh = 0
        try { $nwh = $e.Current.NativeWindowHandle } catch {}
        $lines += ("CTL`t{0}`t{1}`t{2}`t{3}`t{4}" -f $ct, (AId $e), $nwh, (RectStr $e), (Clean $e.Current.Name))
      } catch {}
    }
    } catch {}
  }
} catch {
  $lines += ("ERR`t" + $_.Exception.Message.Split("`n")[0])
}
[System.IO.File]::WriteAllLines($Out, $lines, [System.Text.UTF8Encoding]::new($false))
