# H3 多场景提示词示例库

不同类型场景的完整三段式提示词示例，供参考改写。

---

## 示例1：真人写实 — 女生独处哼唱（I2VA，5s）

**场景**：室内，年轻女性自然哼唱，写实风格  
**模型**：v2 full INT8 + SageAttention  
**比例**：2:3，megapixels=0.6

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, close-up to medium-close shot, a young East Asian woman in her early 20s shown in <Picture 1> keeps her natural appearance, casual top, loose hair, seated position near a window or beside a bed. She begins in a relaxed standing posture, shoulders loose, with a serene expression and a faint smile.
[0s-2s] She takes a gentle breath and starts humming softly; her body produces a subtle, warm micro-sway — shoulders slightly lower, head gently nodding with the rhythm. The camera holds steady with a slight natural handheld drift.
[2s-4s] The melody flows naturally; her eyes slowly lift and curve into a crescent smile, genuine joy spreading from the corners of her mouth. Her body sways lightly with the tune — smooth and continuous — one hand may briefly touch her hair or rest at her side, fingers moving softly with the rhythm.
[4s-5s] The hum rises to a soft peak then gently fades; the final note carries a slight upward lilt. She exhales with warmth, smile lingering, eyes bright and contented. The shot holds on her face — relaxed, unguarded, immersed in the afterglow of the melody.
The indoor space stays consistent throughout: soft diffused natural light from the left, slight film grain, no cuts, no dramatic camera movement.

overall_soundscape: Soft indoor ambience — faint room tone, gentle breath sounds between phrases, the subtle rustle of fabric as she moves. No environmental noise.

non_diegetic_music: None. Pure a cappella female vocal humming only — warm, sweet timbre, natural breathing, gently undulating melody. No instrumental accompaniment, no background music of any kind.
```

---

## 示例2：产品广告 — 护肤品特写（T2VA，5s）

**场景**：电商产品展示，清晰文字，光感强  
**模型**：v2 full INT8（需要文字准确）  
**比例**：1:1 或 16:9，megapixels=0.6

```
integrated_multimodal_description: [Shot 1] Commercial product video, close-up macro shot, a sleek amber glass serum bottle labeled "GLOW ESSENCE 精华液" centered on a white marble surface. The bottle rotates slowly counterclockwise at 15 degrees per second. Warm golden-hour light from the upper right casts a soft specular highlight along the bottle's curved shoulder; the label text remains sharp and legible throughout. Delicate golden liquid droplets catch the light as they fall in slow motion around the bottle.
At 00:03.000 [Shot 2] Camera pulls back to reveal a medium product lifestyle shot — the serum bottle surrounded by fresh white camellias on the marble surface. A woman's elegant hand enters frame from the left, picks up the bottle, and tilts it gently toward camera, label fully visible.

overall_soundscape: Pristine studio silence with a very faint, luxurious ambient hum. A single soft click as the bottle is set down. No dialogue.

non_diegetic_music: Minimal piano with gentle string pads — slow tempo (60 BPM), delicate and airy, building subtly from Shot 1 to Shot 2.
```

---

## 示例3：动画/卡通 — 角色行走（T2VA，5s）

**场景**：2D 动画风格，卡通人物，快节奏  
**模型**：v1 pruned INT8（卡通/动画推荐）  
**比例**：16:9，megapixels=0.42

```
integrated_multimodal_description: [Shot 1] 2D animated style, vibrant color palette, medium shot, a cheerful cartoon girl with large expressive eyes and twin ponytails walks along a sunlit cobblestone street lined with colorful flower stalls. She bounces lightly with each step, her ponytails swinging in rhythm. At 00:02.000 she spots something off-screen to the right — her eyes widen with excitement and she breaks into a run, arms pumping, ponytails flying horizontally. The camera follows her in a smooth side-tracking shot.
At 00:04.000 [Shot 2] Close-up of her face — eyes sparkling, cheeks flushed pink with a big open smile, a cute sweat bead flying off. She comes to a sudden stop with a comedic skid, dust puff rising at her feet.

overall_soundscape: Light footstep sounds on cobblestone, cartoon running sound effect (fast pattering), comedic skid squeak on stop. Cheerful ambient market chatter in background.

non_diegetic_music: Upbeat ukulele and xylophone — fast tempo (130 BPM), playful staccato melody, bright and energetic throughout with a brief comedic "boing" accent at the skid stop.
```

---

## 示例4：抖音竖屏自拍 — 生活 vlog（I2VA，10s，一镜到底）

**场景**：室内自拍，生活化，日常动作  
**模型**：v2 full INT8  
**比例**：2:3，megapixels=0.6

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, phone-front-camera selfie style, the young Chinese woman shown in <Picture 1> keeps her appearance, casual white T-shirt, loose hair down, seated on a bed with off-white sheets. Phone held in right hand at a slight upward angle.
[0s-2s] She glances at something off to her left with a small thoughtful expression, then turns back to camera with a natural relaxed smile, lips slightly parted as if about to speak.
[2s-5s] She reaches over to the nightstand with her left hand, picks up a white ceramic mug, and takes a slow sip of coffee. Her eyes close briefly in satisfaction; a soft "mm" sound escapes.
[5s-8s] She sets the mug back down and tucks a strand of hair behind her ear, looking directly into the camera with a calm, warm gaze. The morning light from the left window highlights her skin texture naturally.
[8s-10s] She takes a gentle breath, breaks into a quiet genuine smile — not performed, just content — and holds the look. The shot holds steady as the warm feeling settles.
The bedroom stays consistent throughout: bookshelf with warm lamp on the left, off-white bed sheets behind her, soft morning window light from the left, gentle handheld sway, no cuts.

overall_soundscape: Quiet morning bedroom ambience — faint birdsong outside, soft ceramic clink as the mug is set down, gentle breath and a soft "mm" of satisfaction. No music.

non_diegetic_music: Soft lo-fi acoustic guitar — very low volume, slow tempo (75 BPM), warm fingerpicked pattern, serving as gentle background texture rather than a dominant musical statement.
```

---

## 示例5：风景/空间延时（T2VA，15s）

**场景**：自然风光，空镜，渐变光线  
**模型**：v1 pruned INT8（风景无人物细节要求低）  
**比例**：16:9，megapixels=0.6

```
integrated_multimodal_description: [Shot 1] Cinematic aerial shot, lush green rice terraces cascading down a mountainside in southern China at golden hour. The camera performs a slow, steady push-forward at low altitude — terraces filling more of the frame — while late afternoon sunlight paints the water-filled paddies in shades of gold and copper. Wisps of mist drift through the lowest terraces.
At 00:05.000 [Shot 2] Ground-level wide shot, the camera positioned between two rows of terraces looking uphill. Sunset light now strikes the water at a low angle, turning each terrace into a mirror of orange sky. A lone farmer in a conical hat walks slowly along the narrow ridge between paddies, silhouetted against the light.
At 00:10.000 [Shot 3] Slow fade to a medium shot of the farmer's hands scooping water from a paddy, held at waist level. Water cascades through fingers in slow motion, catching the last rays of golden light. The camera tilts up slowly to reveal the full terrace landscape now bathed in deep amber dusk.

overall_soundscape: Natural mountain ambience — gentle wind through grass, distant flowing water, faint birdsong tapering off as dusk approaches. The soft sound of water as the farmer's hands move through the paddy.

non_diegetic_music: Slow, meditative guqin (古琴) solo — sparse, pentatonic phrases with long silences between, evoking calm and timelessness. Gradually joined by subtle cello in the final shot.
```

---

## 示例6：Ref2VA 全参考 — 人物动作迁移

**场景**：保留参考视频的动作，迁移到新角色  
**模型**：v2 full INT8（需要专门的 ref2va 模型权重）  
**比例**：2:3，megapixels=0.6

```
subject_definitions:
<Picture 1>: Target character — a young Chinese woman with shoulder-length black hair, wearing a mint green dress, indoors with soft warm lighting.
<Video 1>: Reference motion source — a woman performing a smooth wave hand gesture followed by a gentle bow, approximately 3 seconds in duration.

summary:
Recreate the wave-and-bow greeting motion from <Video 1> performed by the character in <Picture 1>, in an indoor setting matching the character's original environment.

retention_analysis:
<Video 1>: Retain the motion trajectory and timing of the wave (right hand rises from waist to shoulder height, fingers relaxed, three gentle side-to-side waves) and the subsequent slight forward bow (approximately 10 degrees). Do not retain the reference character's appearance, clothing, or background.
<Picture 1>: Retain the character's exact appearance, hair, clothing, facial features, and the indoor background with warm lighting.

integrated_multimodal_description: [Shot 1] Live-action, medium shot, the character from <Picture 1> stands centered in frame in her indoor setting. At 0.00 seconds, she performs the wave gesture from <Video 1> — right hand rising from waist to shoulder height, relaxed fingers waving gently three times — with a warm smile. At 00:03.000 she transitions into the gentle forward bow, approximately 10 degrees, eyes maintaining soft eye contact with camera throughout.

overall_soundscape: Quiet indoor ambience. A gentle exhale as she bows. No dialogue.

non_diegetic_music: Soft, warm acoustic guitar — 80 BPM, simple chord progression, light and welcoming.
```
