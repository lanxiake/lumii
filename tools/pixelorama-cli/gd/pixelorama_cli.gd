extends SceneTree
## Pixelorama CLI 命令执行器
##
## 用法：
##   godot --headless --path <Pixelorama 项目> --script <本文件绝对路径> -- <任务.json>
##
## 为什么是这个形态（都是实测换来的，别改回去）：
##
## 1. **为什么用 `--script` 而不是给 Main.gd 加子命令。**
##    Pixelorama 上游的 CLI 是"打开文件 → 导出"，`args_list` 里没有编辑能力。
##    加子命令要改上游源码，用它自己的 CLI 框架，升级即冲突。
##    实测 `--script` 可以用**绝对路径**指到项目外的文件（`USERARGS` 也正常），
##    所以这个执行器可以完全活在上游仓库之外。
##
## 2. **为什么走 SceneTree 脚本、而不是 `Main.tscn`。**
##    实测本项目跑 `--script` 时 autoload（Global / Themes / ...）仍会 ready 并报一堆
##    `theme is null`、`find_child on null` —— 那是它们假设 Main.tscn 的节点树存在。
##    **这些报错发生在脚本跑完之后，不影响纯算法类**：探针里 `RegionUnpacker` 照样
##    精确切出了三个方块。所以命令执行器只用**不依赖 autoload 的类**（见下），
##    绝不碰 `Global.current_project` 那一路（Project.gd 里有 97 处 Global 引用）。
##
## 3. **为什么一次启动吃一个任务文件、而不是一次一个命令。**
##    Godot 冷启动本项目约 2–5 秒（实测首帧前要加载上百个资源）。
##    逐条命令起一次进程，Agent 调十次就等半分钟。任务文件一次跑完一批。
##
## 4. **JSON 为什么要用标记包起来。**
##    Godot 往 stdout 打大量 `Loading resource: ...` 日志，`--quiet` 也压不干净。
##    接收侧靠标记取真正的结果，别去"猜第几行是 JSON"。

const OUT_BEGIN := "<<<PIXELORAMA_CLI_JSON>>>"
const OUT_END := "<<<PIXELORAMA_CLI_JSON_END>>>"

## 与 `cells-quality.mjs` 同源的背景色判据：取最外圈像素的**逐通道中位数**。
## 踩过的两个坑（别改回四角或声明值）：
##   · AI 出图的底色带噪点，四个角能取到四个互不相同的值；
##     "多数派"在四值各一票时退化成"第一个"，整格会被算成内容。
##   · 声明值更不可信——历史产物里只有一只真是 #00ffff。
const BG_EDGE := 3

var _results: Array = []
var _t0 := 0


func _init() -> void:
	_t0 = Time.get_ticks_msec()
	var user_args := OS.get_cmdline_user_args()
	if user_args.is_empty():
		_fail("没有任务文件。用法：--script <this.gd> -- <task.json>")
		return
	var task_path := user_args[0]
	if not FileAccess.file_exists(task_path):
		_fail("任务文件不存在：%s" % task_path)
		return
	var text := FileAccess.get_file_as_string(task_path)
	var parsed: Variant = JSON.parse_string(text)
	if parsed == null or typeof(parsed) != TYPE_DICTIONARY:
		_fail("任务文件不是合法 JSON 对象：%s" % task_path)
		return
	var task: Dictionary = parsed
	var commands: Array = task.get("commands", [])
	for i in commands.size():
		var cmd: Dictionary = commands[i]
		var op: String = str(cmd.get("op", ""))
		var entry := {"index": i, "op": op}
		var payload: Dictionary = _dispatch(op, cmd)
		entry.merge(payload)
		_results.append(entry)
	_emit(task.get("id", ""))


## 分发。未知 op 不是致命错误——把错误放进这一条的结果里，
## 后面的命令继续跑（一批任务里挂一条不该让整批作废）。
func _dispatch(op: String, cmd: Dictionary) -> Dictionary:
	match op:
		"probe":
			return _op_probe()
		"analyze":
			return _op_analyze(cmd)
		"slice":
			return _op_slice(cmd)
		"cutout":
			return _op_cutout(cmd)
		"clean":
			return _op_clean(cmd)
		"quantize":
			return _op_quantize(cmd)
		"save_frames":
			return _op_save_frames(cmd)
		"save":
			return _op_save(cmd)
		_:
			return {"ok": false, "error": "未知 op：%s" % op}


# ---------------------------------------------------------------- 图片读写

## 载入图片。返回 [Image, null] 或 [null, 错误串]。
## 用 `load_png_from_buffer` 而不是 `Image.load()`：后者按扩展名分派，
## 而这些图可能是 AI 出的 jpg/webp，扩展名不一定可信。
func _load_image(path: String) -> Array:
	if not FileAccess.file_exists(path):
		return [null, "文件不存在：%s" % path]
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return [null, "打不开：%s" % path]
	var buf := f.get_buffer(f.get_length())
	f.close()
	var img := Image.new()
	var err := img.load_png_from_buffer(buf)
	if err != OK:
		err = img.load_jpg_from_buffer(buf)
	if err != OK:
		err = img.load_webp_from_buffer(buf)
	if err != OK:
		return [null, "不是能识别的图片格式（png/jpg/webp）：%s" % path]
	img.convert(Image.FORMAT_RGBA8)
	return [img, null]


func _save_png(img: Image, path: String) -> String:
	var dir := path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir):
		var mk := DirAccess.make_dir_recursive_absolute(dir)
		if mk != OK:
			return "建不了目录：%s (err %d)" % [dir, mk]
	var err := img.save_png(path)
	if err != OK:
		return "写不进去：%s (err %d)" % [path, err]
	return ""


## 背景色估计：最外圈 BG_EDGE 环像素的逐通道中位数。
func _estimate_bg(img: Image) -> Color:
	var w := img.get_width()
	var h := img.get_height()
	var rs: Array[int] = []
	var gs: Array[int] = []
	var bs: Array[int] = []
	for y in h:
		for x in w:
			if x >= BG_EDGE and y >= BG_EDGE and x < w - BG_EDGE and y < h - BG_EDGE:
				continue
			var c := img.get_pixel(x, y)
			rs.append(int(c.r * 255.0))
			gs.append(int(c.g * 255.0))
			bs.append(int(c.b * 255.0))
	rs.sort()
	gs.sort()
	bs.sort()
	var mid := rs.size() >> 1
	return Color8(rs[mid], gs[mid], bs[mid], 255)


# ---------------------------------------------------------------- 各项操作

func _op_probe() -> Dictionary:
	# 只报**实测能 new 出来**的类。两个坑都踩过，别重蹈：
	#
	#   1. `ClassDB.class_exists` 对它们返回 false（`class_name` 是脚本层注册，
	#      不进 C++ 类表），所以**不能拿 ClassDB 当判据**——能 `new()` 出来才是真凭据。
	#   2. 光看"引用了多少次 `Global.`"**不够**。`FloodFillObject` 一处 `Global.` 都没有，
	#      却在 `FloodFillObject.gd:94` 用了 `DrawingAlgos` —— 照样编译失败。
	#
	# **正确的判据**：把这个类的 .gd 文件里出现的**每一个 autoload 标识符**都查一遍。
	# 本项目的 12 个 autoload 是：
	#   Global, Import, OpenSave, DrawingAlgos, Tools, Html5FileExchange,
	#   Export, Palettes, Keychain, ExtensionsApi, Themes, Applinks
	# 只要出现任何一个（哪怕只是在 `DrawingAlgos.` 这种调用形态里），
	# `--script` 模式下就会 `Identifier not found` + `Failed to compile depended scripts`，
	# **整个执行器加载失败**（不是"这个类不能用"而已，是全盘皆输，很难查）。
	#
	# 目前只有一个类通过了这条判据：
	var classes := {"RegionUnpacker": RegionUnpacker.new(0, 0) != null}
	return {
		"ok": true,
		"godot": Engine.get_version_info()["string"],
		"pixelorama_project": ProjectSettings.get_setting("application/config/version", ""),
		"pixelorama_name": ProjectSettings.get_setting("application/config/name", ""),
		"display_server": DisplayServer.get_name(),
		"classes": classes,
		"autoloads": ProjectSettings.get_setting("autoload", {}).keys(),
	}


## 分析一张图：尺寸、背景色、内容包围盒、颜色数。
## 这是"AI 出的图到底怎么样"的第一手数据，比肉眼看可靠。
func _op_analyze(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var img: Image = loaded[0]
	var w := img.get_width()
	var h := img.get_height()
	var bg := _estimate_bg(img)

	var tol: float = float(cmd.get("tol", 60.0))
	var x0 := w
	var x1 := -1
	var y0 := h
	var y1 := -1
	var n := 0
	var opaque := 0
	var colors := {}
	# 逐像素扫。1024×1024 = 100 万像素，GDScript 里这个循环约 1–2 秒，可接受。
	# 真要更快得走 shader，但 headless 的 dummy 渲染器跑不了 shader（见 README）。
	for y in h:
		for x in w:
			var c := img.get_pixel(x, y)
			if c.a < 0.5:
				continue
			opaque += 1
			var d := absf(c.r - bg.r) + absf(c.g - bg.g) + absf(c.b - bg.b)
			if d > tol / 255.0:
				n += 1
				colors[c.to_rgba32()] = true
				if x < x0:
					x0 = x
				if x > x1:
					x1 = x
				if y < y0:
					y0 = y
				if y > y1:
					y1 = y
	var box := {}
	if n > 0:
		box = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "w": x1 - x0 + 1, "h": y1 - y0 + 1}
	return {
		"ok": true,
		"file": path,
		"size": [w, h],
		"bg": bg.to_html(false),
		"bg_rgb": [int(bg.r * 255), int(bg.g * 255), int(bg.b * 255)],
		"has_alpha": img.detect_alpha() != Image.ALPHA_NONE,
		"opaque_px": opaque,
		"content_px": n,
		"content_pct": snappedf(100.0 * float(n) / float(w * h), 0.01),
		"box": box,
		"distinct_colors": colors.size(),
	}


## 切片。两种模式：
##   auto  —— Pixelorama 的 SmartSlicer（RegionUnpacker），按**空白行/列**找独立区域。
##            这是上游真正独有的东西：AI 出的图里角色经常撑破格子、几格连成一片，
##            按固定网格切会把邻格的角色切进来，而按空白切能找到真实的角色边界。
##   grid  —— 固定行列，给"格子清楚、就是要按 N×M 切"的场合。
func _op_slice(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var img: Image = loaded[0]
	var mode: String = cmd.get("mode", "auto")
	if mode == "grid":
		var cols: int = int(cmd.get("cols", 1))
		var rows: int = int(cmd.get("rows", 1))
		if cols < 1 or rows < 1:
			return {"ok": false, "error": "cols/rows 必须 >= 1"}
		var w := img.get_width()
		var h := img.get_height()
		if w % cols != 0 or h % rows != 0:
			return {
				"ok": false,
				"error": "尺寸 %d×%d 不能被 %d×%d 整除，会切出带小数的格子" % [w, h, cols, rows],
			}
	var found := _compute_rects(img, cmd)
	var rects: Array = []
	for r: Rect2i in found:
		rects.append({"x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y})
	return {"ok": true, "file": path, "mode": mode, "count": rects.size(), "rects": rects}


## 抠背景：从**四条边**泛洪，把与背景色连通且颜色接近的部分变透明。
##
## 为什么从边泛洪、而不是"把接近背景色的像素全删掉"：
## 后者会把角色**内部**与背景色相近的区域也挖空（比如白猫身上的白）。
## 泛洪只吃掉"和画布边缘连得通"的那片，角色内部被描边围住的同色区域保得住——
## 这正是 pet-creator 那条"容差超过描边色距底色的距离就会穿透描边"的约束所保护的。
func _op_cutout(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var img: Image = loaded[0]
	var w := img.get_width()
	var h := img.get_height()

	var bg := _estimate_bg(img)
	if cmd.has("bg"):
		var specified: Variant = cmd["bg"]
		if typeof(specified) == TYPE_ARRAY and specified.size() >= 3:
			bg = Color8(int(specified[0]), int(specified[1]), int(specified[2]), 255)

	var tol := float(cmd.get("tol", 60.0)) / 255.0
	var removed := _flood_cutout(img, bg, tol)

	# 抠完之后重新算包围盒，好让调用方知道角色到底占多大
	var box := _content_box(img)

	var out_path: String = cmd.get("out", "")
	if out_path != "":
		var err := _save_png(img, out_path)
		if err != "":
			return {"ok": false, "error": err}

	return {
		"ok": true,
		"file": path,
		"out": out_path,
		"bg_rgb": [int(bg.r * 255), int(bg.g * 255), int(bg.b * 255)],
		"tol": int(tol * 255.0),
		"removed_px": removed,
		"removed_pct": snappedf(100.0 * float(removed) / float(w * h), 0.01),
		"box": box,
	}


## 泛洪抠底本体（cutout 与 clean 共用）。返回被抹掉的像素数。
##
## **从四条边泛洪**，而不是"把接近背景色的像素全删掉"：后者会把角色**内部**
## 与背景色相近的区域也挖空（白猫身上的白）。泛洪只吃掉"和画布边缘连得通"的那片，
## 被描边围住的同色区域保得住——这正是 pet-creator 那条"容差超过描边色距底色的距离
## 就会穿透描边"的约束所保护的。
##
## 四条边**全部**入栈，不能只取四角：AI 出的图四角常被噪点污染，只取角会漏掉整条边。
func _flood_cutout(img: Image, bg: Color, tol: float) -> int:
	var w := img.get_width()
	var h := img.get_height()
	var visited := PackedByteArray()
	visited.resize(w * h)
	var stack: Array[Vector2i] = []
	for x in w:
		stack.append(Vector2i(x, 0))
		stack.append(Vector2i(x, h - 1))
	for y in h:
		stack.append(Vector2i(0, y))
		stack.append(Vector2i(w - 1, y))

	var removed := 0
	while not stack.is_empty():
		var p: Vector2i = stack.pop_back()
		if p.x < 0 or p.y < 0 or p.x >= w or p.y >= h:
			continue
		var idx := p.y * w + p.x
		if visited[idx] == 1:
			continue
		var c := img.get_pixel(p.x, p.y)
		var d := absf(c.r - bg.r) + absf(c.g - bg.g) + absf(c.b - bg.b)
		if d > tol:
			continue
		visited[idx] = 1
		# 只在真的不透明时才计数，好让"已抠干净"和"本来就透明"分得开
		if c.a > 0.0:
			removed += 1
		img.set_pixel(p.x, p.y, Color(0, 0, 0, 0))
		stack.append(Vector2i(p.x + 1, p.y))
		stack.append(Vector2i(p.x - 1, p.y))
		stack.append(Vector2i(p.x, p.y + 1))
		stack.append(Vector2i(p.x, p.y - 1))
	return removed


## 非透明内容的包围盒。空图返回 {}。
func _content_box(img: Image) -> Dictionary:
	var w := img.get_width()
	var h := img.get_height()
	var x0 := w
	var x1 := -1
	var y0 := h
	var y1 := -1
	for y in h:
		for x in w:
			if img.get_pixel(x, y).a > 0.5:
				if x < x0:
					x0 = x
				if x > x1:
					x1 = x
				if y < y0:
					y0 = y
				if y > y1:
					y1 = y
	if x1 < 0:
		return {}
	return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "w": x1 - x0 + 1, "h": y1 - y0 + 1}


## 一步到位：**抠底 → 切片 → 归一化 → 导出独立帧**。
##
## 顺序是硬的，**不能把切片提到抠底前面**：
## `RegionUnpacker` 判空用的是 `get_pixelv(p).a > 0`（实测源码），
## 而 AI 出的图整张不透明——没抠底就切，整张图会被当成**一个**连通区域。
## 抠底把背景变成 alpha=0 之后，它才能按"真正的空白"找到每个角色。
##
## 归一化（`canvas` 给了才做）：把每帧摆到同尺寸画布上、按**内容底边中心**对齐。
## 精灵图要求每帧同尺寸同锚点，否则播起来角色会一跳一跳。
## 切出来的区域天然大小不一是正常的（AI 画的动作本来就有伸缩），不是错误。
func _op_clean(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var img: Image = loaded[0]
	var out_dir: String = cmd.get("out_dir", "")
	if out_dir == "":
		return {"ok": false, "error": "需要 out_dir"}
	var prefix: String = cmd.get("prefix", "frame")

	var bg := _estimate_bg(img)
	if cmd.has("bg"):
		var specified: Variant = cmd["bg"]
		if typeof(specified) == TYPE_ARRAY and specified.size() >= 3:
			bg = Color8(int(specified[0]), int(specified[1]), int(specified[2]), 255)
	var tol := float(cmd.get("tol", 60.0)) / 255.0
	var removed := _flood_cutout(img, bg, tol)

	# 切片：对抠底后的图做
	var rects := _compute_rects(img, cmd)
	if rects.is_empty():
		return {
			"ok": false,
			"error": "抠底后没找到任何内容。容差可能过大（把角色也吃掉了），或这张图本来就是空的。",
			"removed_pct": snappedf(100.0 * float(removed) / float(img.get_width() * img.get_height()), 0.01),
			"bg_rgb": [int(bg.r * 255), int(bg.g * 255), int(bg.b * 255)],
			"tol": int(tol * 255.0),
		}

	# 归一化：目标画布 = 显式给的 canvas，否则取所有帧的最大宽高
	var pieces: Array[Image] = []
	for r: Rect2i in rects:
		pieces.append(img.get_region(r.intersection(Rect2i(0, 0, img.get_width(), img.get_height()))))

	var cw := 0
	var chh := 0
	if cmd.has("canvas"):
		var c: Variant = cmd["canvas"]
		if typeof(c) == TYPE_DICTIONARY and c.has("w") and c.has("h"):
			cw = int(c["w"])
			chh = int(c["h"])
	if cw <= 0 or chh <= 0:
		for p: Image in pieces:
			cw = maxi(cw, p.get_width())
			chh = maxi(chh, p.get_height())

	# 先把所有帧摆到统一画布上，**攒齐了再量化**——
	# 调色板要所有帧共用一套，否则帧之间颜色跳变（见 `_build_palette`）。
	var canvases: Array[Image] = []
	for piece: Image in pieces:
		var canvas := Image.create_empty(cw, chh, false, Image.FORMAT_RGBA8)
		canvas.fill(Color(0, 0, 0, 0))
		# 水平居中、底边对齐 —— 脚踩在同一条线上是精灵图的硬要求
		var dx := (cw - piece.get_width()) / 2
		var dy := chh - piece.get_height()
		canvas.blit_rect(piece, Rect2i(0, 0, piece.get_width(), piece.get_height()), Vector2i(dx, dy))
		canvases.append(canvas)

	var quantize_n := int(cmd.get("colors", 0))
	var palette_hex: Array = []
	if quantize_n >= 2 and not canvases.is_empty():
		var palette := _build_palette(canvases, quantize_n)
		var cache := {}
		for canvas: Image in canvases:
			_apply_palette(canvas, palette, cache)
		for p: Color in palette:
			palette_hex.append(p.to_html(false))

	var written: Array = []
	for i in canvases.size():
		var name := "%s_%02d.png" % [prefix, i]
		var full := out_dir.path_join(name)
		var err := _save_png(canvases[i], full)
		if err != "":
			return {"ok": false, "error": err}
		written.append({"file": full, "w": cw, "h": chh})

	return {
		"ok": true,
		"file": path,
		"out_dir": out_dir,
		"bg_rgb": [int(bg.r * 255), int(bg.g * 255), int(bg.b * 255)],
		"tol": int(tol * 255.0),
		"removed_px": removed,
		"removed_pct": snappedf(100.0 * float(removed) / float(img.get_width() * img.get_height()), 0.01),
		"count": written.size(),
		"canvas": [cw, chh],
		"palette": palette_hex,
		"frames": written,
		"source_rects": rects.map(func(r: Rect2i) -> Array: return [r.position.x, r.position.y, r.size.x, r.size.y]),
	}


## 算出切片矩形。auto 走 Pixelorama 的 SmartSlicer；grid 按固定行列。
func _compute_rects(img: Image, cmd: Dictionary) -> Array[Rect2i]:
	var out: Array[Rect2i] = []
	var mode: String = cmd.get("mode", "auto")
	if mode == "grid":
		var cols: int = int(cmd.get("cols", 1))
		var rows: int = int(cmd.get("rows", 1))
		if cols < 1 or rows < 1:
			return out
		var w := img.get_width()
		var h := img.get_height()
		if w % cols != 0 or h % rows != 0:
			return out
		var cw := w / cols
		var chh := h / rows
		for r in rows:
			for c in cols:
				out.append(Rect2i(c * cw, r * chh, cw, chh))
		return out

	var unpacker := RegionUnpacker.new(int(cmd.get("threshold", 0)), int(cmd.get("merge_dist", 0)))
	var data: RegionUnpacker.RectData = unpacker.get_used_rects(img)
	for r: Rect2i in data.rects:
		out.append(r)
	# 阅读顺序（上→下、左→右）。RegionUnpacker 自带的 sort_rects 注释写着
	# "试了很多次才 work，最好别动它"——不依赖它，自己排，
	# 因为"格子的阅读顺序就是时间顺序"是这条链路的前提。
	out.sort_custom(
		func(a: Rect2i, b: Rect2i) -> bool:
			if absi(a.position.y - b.position.y) < maxi(a.size.y, b.size.y) / 2:
				return a.position.x < b.position.x
			return a.position.y < b.position.y
	)
	return out


# ---------------------------------------------------------------- 调色板量化

## 把颜色拆成 [r, g, b]。`Color.to_rgba32()` 里 R 在最高字节。
func _unpack(c: int) -> Array:
	return [(c >> 24) & 0xFF, (c >> 16) & 0xFF, (c >> 8) & 0xFF]


## 中位切分（median cut）求调色板。
##
## 为什么不用 Pixelorama 自带的 `PalettizeDialog`：它走 GPU shader
## （`Palettize.gdshaderinc` + `ShaderImageEffect`），而 headless 用的是
## **dummy 渲染后端**，shader 根本不跑。所以这一块只能自己实现。
##
## 只用 GDScript 就够快的原因：先统计**唯一色直方图**再切分。
## AI 出的图看着有几万色，但唯一色就那么多，直方图规模远小于像素数。
## 真正贵的是后面的映射，那一步用缓存表压到"每个唯一色算一次"。
##
## 多张图一起传进来是为了出**一套共用调色板**——各帧各算一套的话，
## 帧与帧之间颜色会跳，播起来闪。
func _build_palette(images: Array, n: int) -> Array:
	var hist := {}
	for img: Image in images:
		var w := img.get_width()
		var h := img.get_height()
		for y in h:
			for x in w:
				var c := img.get_pixel(x, y)
				if c.a < 0.5:
					continue
				var key := c.to_rgba32()
				hist[key] = int(hist.get(key, 0)) + 1
	if hist.is_empty():
		return []
	var boxes: Array = [hist.keys()]
	# 每个盒子已含的**像素总数**，与 boxes 平行。
	# 切分时增量更新，避免每轮重新遍历盒内所有颜色（那是 O(n²)）。
	var total_px := 0
	for c: int in hist.keys():
		total_px += int(hist[c])
	var weights: Array = [total_px]
	while boxes.size() < n:
		# 切**像素数最多**的盒子，而不是颜色数最多的。
		#
		# 这一条是实测改过来的：AI 出图有极重的长尾——一张图 51950 个唯一色，
		# 出现最多的 10 个颜色只占 28% 的像素，其余 72% 是几万种**各不相同的相近色**
		# （抗锯齿边缘的混合色，每个都只出现几次）。
		# 按"颜色数"切，这些噪点色会凭种类多抢走大半盒子，主色的色阶反而分不到；
		# 实测那样切出来的调色板里混进了角色的边缘残留色。
		var bi := 0
		var best := -1
		for i in weights.size():
			if weights[i] > best:
				best = weights[i]
				bi = i
		var box: Array = boxes[bi]
		if box.size() < 2:
			# 这个盒子已经切不动了。换个盒子试；全都不行就停。
			var moved := false
			for i in boxes.size():
				if boxes[i].size() >= 2 and weights[i] > 0:
					bi = i
					box = boxes[i]
					best = weights[i]
					moved = true
					break
			if not moved:
				break
		# 沿跨度最大的通道切
		var lo := [255, 255, 255]
		var hi := [0, 0, 0]
		for c: int in box:
			var rgb := _unpack(c)
			for k in 3:
				lo[k] = mini(lo[k], rgb[k])
				hi[k] = maxi(hi[k], rgb[k])
		var ch := 0
		if hi[1] - lo[1] > hi[ch] - lo[ch]:
			ch = 1
		if hi[2] - lo[2] > hi[ch] - lo[ch]:
			ch = 2
		var ch_fixed := ch
		box.sort_custom(
			func(a: int, b: int) -> bool: return _unpack(a)[ch_fixed] < _unpack(b)[ch_fixed]
		)
		var mid := box.size() / 2
		var left: Array = box.slice(0, mid)
		var right: Array = box.slice(mid)
		var left_px := 0
		for c: int in left:
			left_px += int(hist[c])
		boxes[bi] = left
		weights[bi] = left_px
		boxes.append(right)
		weights.append(best - left_px)

	# 每盒取**按出现次数加权**的平均色。不加权的话，
	# 一个只出现 3 次的噪点色会和出现 3 万次的主色等权，把调色板带偏。
	var palette: Array = []
	for box: Array in boxes:
		if box.is_empty():
			continue
		var r := 0.0
		var g := 0.0
		var b := 0.0
		var total := 0.0
		for c: int in box:
			var wt := float(hist[c])
			var rgb := _unpack(c)
			r += float(rgb[0]) * wt
			g += float(rgb[1]) * wt
			b += float(rgb[2]) * wt
			total += wt
		if total <= 0.0:
			continue
		palette.append(Color8(int(r / total), int(g / total), int(b / total), 255))
	return palette


func _nearest_in(c: Color, palette: Array) -> Color:
	var best: Color = palette[0]
	var bd := 1e18
	for p: Color in palette:
		var dr := c.r - p.r
		var dg := c.g - p.g
		var db := c.b - p.b
		var d := dr * dr + dg * dg + db * db
		if d < bd:
			bd = d
			best = p
	return best


## 把一张图映射到调色板。`cache` 跨图共用，同色只算一次最近邻。
## 返回被改动的像素数。
##
## 缓存里直接存 `Color`（不是打包后的 int）：Godot 4.7 **没有 `Color.from_rgba32`**
## 这个反向方法，存 int 就得自己解包再拼回去。存 Color 省掉这一步。
func _apply_palette(img: Image, palette: Array, cache: Dictionary) -> int:
	if palette.is_empty():
		return 0
	var w := img.get_width()
	var h := img.get_height()
	var changed := 0
	for y in h:
		for x in w:
			var c := img.get_pixel(x, y)
			if c.a < 0.5:
				continue
			var key := c.to_rgba32()
			var mapped: Variant = cache.get(key)
			if mapped == null:
				mapped = _nearest_in(c, palette)
				cache[key] = mapped
			var mc: Color = mapped
			if mc.to_rgba32() != key:
				changed += 1
			img.set_pixel(x, y, mc)
	return changed


func _op_quantize(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var img: Image = loaded[0]
	var n := int(cmd.get("colors", 32))
	if n < 2:
		return {"ok": false, "error": "colors 至少要 2"}

	var before := {}
	for y in img.get_height():
		for x in img.get_width():
			var c := img.get_pixel(x, y)
			if c.a >= 0.5:
				before[c.to_rgba32()] = true

	var palette := _build_palette([img], n)
	var changed := _apply_palette(img, palette, {})

	var out: String = cmd.get("out", "")
	if out != "":
		var err := _save_png(img, out)
		if err != "":
			return {"ok": false, "error": err}

	var hexes: Array = []
	for p: Color in palette:
		hexes.append(p.to_html(false))
	return {
		"ok": true,
		"file": path,
		"out": out,
		"colors_requested": n,
		"colors_before": before.size(),
		"colors_after": palette.size(),
		"changed_px": changed,
		"palette": hexes,
	}


## 按矩形列表把图切成若干张独立 PNG。
## 名字里带序号，序号就是 rects 的顺序（阅读顺序 = 时间顺序）。
func _op_save_frames(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var img: Image = loaded[0]
	var rects: Array = cmd.get("rects", [])
	var out_dir: String = cmd.get("out_dir", "")
	var prefix: String = cmd.get("prefix", "frame")
	if out_dir == "" or rects.is_empty():
		return {"ok": false, "error": "需要 out_dir 与非空 rects"}
	var written: Array = []
	for i in rects.size():
		var r: Dictionary = rects[i]
		var rect := Rect2i(int(r["x"]), int(r["y"]), int(r["w"]), int(r["h"]))
		# 夹一下：RegionUnpacker 在某些图上会返回越界 1px 的矩形
		rect = rect.intersection(Rect2i(0, 0, img.get_width(), img.get_height()))
		if rect.size.x <= 0 or rect.size.y <= 0:
			continue
		var piece := img.get_region(rect)
		var name := "%s_%02d.png" % [prefix, i]
		var full := out_dir.path_join(name)
		var err := _save_png(piece, full)
		if err != "":
			return {"ok": false, "error": err}
		written.append({"file": full, "w": rect.size.x, "h": rect.size.y})
	return {"ok": true, "count": written.size(), "frames": written}


func _op_save(cmd: Dictionary) -> Dictionary:
	var path: String = cmd.get("file", "")
	var loaded := _load_image(path)
	if loaded[0] == null:
		return {"ok": false, "error": loaded[1]}
	var out: String = cmd.get("out", "")
	if out == "":
		return {"ok": false, "error": "需要 out"}
	var err := _save_png(loaded[0], out)
	if err != "":
		return {"ok": false, "error": err}
	return {"ok": true, "out": out}


# ---------------------------------------------------------------- 输出

func _fail(msg: String) -> void:
	_results.append({"ok": false, "error": msg})
	_emit("")


## 结果用标记包起来打。Godot 的日志混在 stdout 里，接收侧只取标记之间的内容。
func _emit(id: String) -> void:
	var payload := {
		"id": id,
		"elapsed_ms": Time.get_ticks_msec() - _t0,
		"results": _results,
		"ok": _results.all(func(r: Dictionary) -> bool: return r.get("ok", false)),
	}
	print(OUT_BEGIN)
	print(JSON.stringify(payload))
	print(OUT_END)
	quit(0)
