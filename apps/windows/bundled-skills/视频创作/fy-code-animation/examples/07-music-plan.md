# 走读07的完整四案音乐

对应 [完整任务卡](07-full-card.md)。约38秒、全部planned；下列方案未生成、未试听，不能保证指定秒数出现对应段落。口播沿用作者已选身份，四案是配乐方案，不是克隆音色方案。

共同意图：0–7.5 s建立，7.5–14 s情绪扩散，约15.8 s减层/留空，22–29.5 s轻幽默，29.5–38 s回归动机并安静收束。实际音乐不能精确接受这些事件，选音后重标时间。密集冲击需让口播中频，结尾留可编辑尾音。

## A 印刷工坊

意图：物件与声音材质对应，节奏像木活字机械而非工业轰鸣。拨弦提琴、木质敲击、低音单簧管，4拍约104BPM；三连情绪段加密，停机处抽掉打击，末段单簧管长音。可读性强，但过密敲击会盖辅音。

完整caption：
> Instrumental chamber score for a thoughtful Mandarin explainer set in a hand-operated newspaper workshop. Pizzicato strings, dry wooden percussion and a restrained bass clarinet carry a small repeating motif. Use a light four-beat mechanical pulse around 104 BPM. Begin sparsely, become busier in the early middle section as messages spread, then make a noticeable pause and reduce the texture. Add a brief playful passage before returning to the opening motif with a quiet sustained clarinet ending. Keep melodic lines and midrange percussion away from narration, with no vocals, no cinematic trailer hits and no triumphant finale. Leave a natural editable decay at the end.

SPEC：caption=上文完整原文，duration=38，bpm=104，keyscale="D minor"，timesignature="4"，seeds=[11]，thinking=true，steps=8，shift=3.0，offload=false。输出目录示意 `music/A-workshop-r1/`。

## B 默片钢琴

意图：用呼吸与乐句支持“快的情绪/慢的核查”，独奏立式琴、自由速度而非机械节拍。短拉格泰姆动机，高潮左手增密，停机处悬和弦，结尾回到开头安静终止。少乐器给人声空间，但旋律若太活跃会抢叙述。

完整caption：
> Instrumental solo upright piano for a reflective newspaper-themed Mandarin narration. Use a modest ragtime-inspired motif with flexible timing and human rubato rather than a strict drum groove. Start with separated notes, briefly increase left-hand movement during a rush of emotional messages, then suspend the motion on a quiet unresolved harmony. Resume with a small humorous figure and return to the opening idea for a gentle, clear cadence. Keep the register and dynamics restrained under speech, allow meaningful gaps between phrases, and avoid virtuosic runs, vocals, percussion and a grand final chord. Preserve a soft natural piano tail.

SPEC：caption=上文，duration=38，省略bpm（自由时间意图），keyscale="C major"，timesignature="4"仅为弱拍号提示，seeds=[23]，thinking=true，steps=8，shift=3.0，offload=false。目录 `music/B-piano-r1/`。自由速度与拍号提示并不保证生成器精确实现rubato。

## C 极简电子

意图：抽象传播与核查过程，干拨音合成器、软低鼓、细噪声刷；96BPM切分，快段叠高频细分，停机处抽空，结尾慢淡。与A的木质脉冲、B的自由钢琴明显不同，但噪声要避免遮蔽齿音。

完整caption：
> Instrumental minimal electronic music for a calm but incisive Mandarin explainer about how information spreads. Use dry plucked synthesizer notes, a soft low kick and very subtle brushed noise. Build a syncopated four-beat pattern around 96 BPM from a short two-note motif. Keep the opening open and sparse, add brief fine subdivisions in the energetic section, then strip the rhythm away for a distinct moment of stillness. Reintroduce only a few elements for the final idea and finish with a restrained fading synth tone. Leave generous midrange space for speech; avoid vocals, aggressive bass, constant risers, glossy arpeggios and an oversized drop.

SPEC：caption=上文，duration=38，bpm=96，keyscale="A minor"，timesignature="4"，seeds=[37]，thinking=true，steps=8，shift=3.0，offload=false。目录 `music/C-electronic-r1/`。

## D 室内弦乐

意图：从急促到可耐心复查，弦乐四重奏拨奏转拉奏，6/8摇摆感；急段密集，静段长和弦，最终解决。节拍、编制、动机形态和结尾都与其他方案不同；弦乐动态必须克制。

完整caption：
> Instrumental string quartet underscore for an intimate Mandarin essay about emotional haste and patient verification. Use a gentle compound-meter six-eight feel, with short pizzicato exchanges that gradually become denser before opening into a sustained bowed harmony. Begin with a quiet questioning motif, create one brief rush of activity, then allow a clear breath of stillness. Support a lightly humorous transition without caricature and resolve the final section into a warm, modest cadence. Keep the arrangement thin beneath narration, without vocals, drums, soaring romantic melodies, dramatic tremolo or a large cinematic climax. Let the last chord decay naturally.

SPEC：caption=上文，duration=38，bpm=84作为速度意图，keyscale="G major"，timesignature="6"为当前脚本传递的拍号字符串；此字段不能表达完整6/8分母语义，复合拍主要在caption描述，实际需试听。seeds=[41]，thinking=true，steps=8，shift=3.0，offload=false。目录 `music/D-quartet-r1/`。

## 选择与实际同步（当前空缺）

作者选定：未选择。实际文件/hash/采样数：无。强拍/乐句/词锚：未实测。混音/编码后检查：未执行。试听时同画面、同范围、匹配大致响度，记录气质、口播空间、快段密度和尾音；不能以四份文字方案充当四首音乐。生成前把每案caption完整放入各自JSON，修改方案必须另开输出目录。
