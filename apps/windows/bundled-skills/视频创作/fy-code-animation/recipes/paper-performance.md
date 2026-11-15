# 纸偶表演、定格印刷与双联灯箱

保留完整技术配方与返修案例。以下具体配色、时长、左右方位和声效密度都是案例选择；按本片含义调整。制作前先读 [阶段与工作流](../modules/workflow.md)。代码片段是实现说明，不是已经在本机运行的完整引擎。

输入：人物身份/关节锚点、动作意图、绘制fps、输出fps、纸层深度、光方向。输出：姿势状态表、贴图烘焙预算、闭式或固定步长回放方案。静止阅读无需添加boil。输出帧率能被绘制帧率整除时持帧最均匀；不整除也可有意使用，但要记录节奏。

## 1. Cut-paper stop-motion print

Printed paper cut-outs shot frame by frame:
- flat colour fields made rich by texture;
- wobbly hand-cut edges;
- soft contact shadows on the sheet behind;
- a stepped pose rate under a perfectly smooth camera.

The paper kit, in four parts:
- `cutPoly`: hand-cut polygons;
- `PAPER`, `paperize`: paper fibre;
- `sprite`, `bakeLayer`: baked sheets with a rim and a shadow;
- `layerT`: parallax depth.

### 1.1 Look and palette
- **Four values do the work:**
  - a mid-value ground;
  - one high-chroma accent for the things that matter;
  - a cream for small lights (windows, collars, highlights);
  - an ink for the smallest details (birds, wires, hair, notes).
- **Flat fields, rich texture.** The frame reads like a print: never smooth airbrushed gradients.
- **Mix every shade toward the ink or toward the paper colour, never toward black or white** (`tone(hex, k)`). That keeps shadows and
  highlights inside the print's palette.
- **Balance:** about 60% ground, 25% accent and its warm neighbours, 15% cream and ink.
  To change the mood, change the ground and the accent as a pair (red on teal, ochre on navy, coral on sage).
- **One accent colour travelling through every shot** ties a short film together.

### 1.2 Materials (baked once, at build time)
| Element | How |
|---|---|
| hand-cut edge | subdivide each edge every ~10–16 px and push the points along the normal by noise (±1 px) |
| paper fibre | a tileable 512² texture of blotches and short fibres, laid over each sprite with `source-atop` at 0.2–0.45 |
| printed backdrop | a vertical gradient, two scales of soft-light mottling, faint print lines, dust, then a warm key-light glow falling to darker corners |
| print texture | parallel, slightly wobbly lines at 8–15% alpha inside a clip on fabric and façades; sparse specks on ceramics and fruit |
| contact shadow | the sprite's own silhouette, blurred, at 0.22–0.38 alpha, offset in world space and drawn first |
| rim of light | the silhouette minus itself shifted away from the light, composited `source-atop` |
| grain | a tile of light and dark specks, offset once per pose |

Bake each sprite at the largest zoom it will be seen at.

### 1.3 Staging
- **Frontal and orthographic.** Floors, ledges and pavements are horizontal bands, and things stand on them like objects on a shelf or a stage.
- **Depth by planes.** Use 3–7 flat sheets at depths p (sky 0.1–0.25 … the puppet plane 1). The camera move scales with p, so a push-in slides
  the sheets past each other.
- **Composition.** One thing moves the eye per shot. Negative space grows toward the end. One quiet oddity per film adds charm.

### 1.4 Characters and props
- **Puppets from flat parts on pivots:**
  - a coat or dress as one cut shape;
  - capsule or stick limbs;
  - a head sprite on a neck pivot, so it can tip and turn.
- **Faces:** drawn live over the head (dot eyes that blink into arcs, a blush that swells), like stop-motion replacement faces.
  Faceless figures work as well.
- **Flying things:** replacement drawings (three wing positions per wingbeat), not a rotated wing.
- **Props:** a body shape filled flat, then shading and texture inside a clip, then details. Everything gets fibre and a shadow.

### 1.5 The stop-motion clock
The picture runs on two clocks, and the contrast between them is the style:

| What | Rate |
|---|---|
| puppet poses | 12 or 15 a second: at 30 fps output, `qt = floor(t · 15) / 15`, so each pose holds for two frames |
| camera | every frame, eased (slow push-ins and drifts) |
| boil | per pose: ±1 px and ±0.003 rad from `hash(id, pose)`, so each pose looks hand-placed again |
| exposure flicker | per pose: ±2.5% brightness from a hash |
| grain | per pose |

- **Divide the output rate evenly:** 24 fps output takes 12 poses a second; 30 fps takes 15 or 10.
  At 30 fps, 12 poses a second alternates two- and three-frame holds and reads as a stutter.
- **Act in explicit states:** a crouch before a jump, a squash on landing, heads turning one after another.

### 1.6 Physics as the puppeteer
Ropes, falling petals, flocks and springy trees look alive when simulated. The film stays a pure function of time as a **deterministic replay**:
- each shot resets from seeded state and steps at a fixed 60 Hz up to the requested frame;
- pre-roll 1–2 s, so things are already moving when the shot starts;
- `draw` reads snapshots and never writes simulation state;
- long shots save a checkpoint every second.

| Thing | Model |
|---|---|
| steam, wires, hair | verlet ropes with gravity or buoyancy, curl-noise sway and pinned ends; perched weights pull a wire down |
| falling petals, feathers | flat-plate flutter: lift and drag with a self-excited pitch oscillation |
| a tree | a seeded branch skeleton with a torsion spring at each node, and forward kinematics |
| a flock | steer toward moving targets with separation, then home firmly to perches |
| hops and throws | ballistic arcs with a set flight time |

Tie events that must hit the music to exact frames. For a longer film, drop the replay: compute everything in closed form from t
(seeded emitters, paths as formulas), and keep the stop-motion clock for the poses.

### 1.7 Story shape and sound
- **A relay of cause and effect** suits a very short film: one handoff per shot, with the same object crossing each cut.
  For example, a note leaves one shot and wakes a bird in the next.
- **A character living the message** suits a talk or a reminder: one set, a few long movements, captions narrating his story.
- **Every note of a melody can also be a visual event:** a bloom, or the pluck of a wire.
- **Sound is synthesised from one score**, for both live playback and offline export (see [音乐与事件声音](../modules/music.md); only when the production phase authorizes audio):
  - a music box (a few inharmonic partials with fast decays and a click);
  - a Karplus–Strong wire; wing flaps (band-passed noise bursts);
  - chirps (a swept sine with light FM); paper rustle; a ceramic clink; creaks and whooshes;
  - per-shot room tones through a generated reverb.

### 1.8 Portrait and text
- **Portrait:** stack the staging vertically, with a sky band at the top, the ledge or street in the lower third and the hero centred.
  The camera tilts rather than tracks.
- **Text, when needed:** letters cut as paper sprites that arrive and boil like everything else, or a clean sans on a quiet band.

### 1.9 Pitfalls
- **`draw` must not touch simulation state.** Otherwise a frame reached after rendering differs from the same frame replayed cold, which `verify.mjs`
  catches. Key any draw cache by the state it depends on.
- **Start shots on the pose grid,** or pose changes and boil drift apart.
- **Pre-roll every shot,** or ropes start out straight.
- **Keep the shadow direction global:** offset it in world space before rotating or flipping.
- **Too many specks turn to noise at thumbnail size;** keep speckle alpha around 0.25–0.5.
- **Bake once and reuse sprites across shots;** blurred shadows are the costly part.

## 2. Paper lightbox diptych

A 20 s saying told in one scene in Canvas 2D.

**Look.** Layered cut paper at night, lit from behind: each sheet is one flat colour with hand-cut edges, paper fibre, a thin rim of light on the
edge that faces the light, and a soft shadow on the sheet behind. Lights (windows, lanterns, neon) are separate additive sheets. The sky is indigo,
warm (gold, amber, rose) behind one side and neon (magenta, cyan, violet) behind the other. A wet floor mirrors both.

**The diptych.** For a saying about two ways, split one scene down a vertical axis instead of cutting between two places: two faceless figures
back to back, each facing his own world, and one hero object behind both, split by the same axis. Here that object is a sun medallion
of 336 inlay pieces. One half gathers, locks and lights from within; the other hovers loose, goes cold, blows away and leaves a ghost lattice.
Every contrast is paired: warm and cold light, still and restless motion, hands at rest and hands grasping, coins that come and a coin that is
empty, flagstones and a wet street. Choose each side from the reading direction and the intended meaning; there is no universally favoured side.

**Recipes (all closed-form in `t`):**
- *Depth without 3D:* each sheet has a depth p (sky 0 … the figures 1, the foreground > 1). The screen scale is `S · zoom^p` and the centre
  `R + p · (cam − R)`, so zooms and pans slide the sheets past each other. Hide each sheet's base behind the one in front by running walls
  down past the ground line.
- *A medallion of pieces:* zig-zag rings, with vertices alternating r ± a, and bands of cells between them, with a half-cell offset every other
  band. Build each cell from the inner ring's points between its two angles plus the outer ring's points reversed, and clip any cell that
  straddles the axis in two (Sutherland–Hodgman against x = 0). Bake each piece three times (plain, backlit warm, neon cold) and crossfade.
  - A piece's state is closed-form: for the burst, pull it toward one of 5 spiral-arm angles and add a spin that grows with radius, so the arms
    unwind as it comes home. Lock it with an ease-out-back at a time staggered by radius and angle. Keep a loose piece loose with noise.
    Give fast pieces two fading copies at t − 0.025 and t − 0.05.
- *Scattering that stays in view:* don't blow the pieces off-screen. A client wanted scattered affairs "dispersed and visible … a mess in
  the sky on his side".
  - Give each piece a target on that side: two thirds in a few piles, a third strewn. Match targets to pieces by angle around the burst
    point, so the burst reads as outward.
  - Ease there with `(1 − e^(−4u)) / (1 − e^(−4))` for clamped u in [0,1], a burst that slows to a drift. End at a random angle and a new depth, and let some pieces keep turning.
  - Draw them in front of the far buildings. His props (bags, phone) join the mess.
  - When he reaches, push the nearest pieces away from his hands. That is "it does not come to him", with no text needed.
- *The wet floor:* after the figures, copy the canvas above the line of their feet into an offscreen flipped (`setTransform(1,0,0,-1,0,h)`)
  with `blur(2px)`. Lay it back in 6 px strips nudged sideways by `sin(y·0.05 + t)`, with alpha falling off as (1 − d)^1.5. Draw
  anything that lies on the floor (coins) afterwards.
- *Figures:* capsule limbs on a joint skeleton, drawn live into their own sheet each frame. Add paper fibre and the rim of whatever light the
  figure faces: the silhouette minus itself shifted away from the light, composited `source-atop`. Expose the world positions of the eye and
  palm (through the lean and head turn), so props land exactly.
- *Hook:* the medallion bursts into spiral arms around a white-gold sun with rays, while big blurred pieces fly past the lens in screen space
  during the first second.
- *16:9 text:* when the hero object fills the height, put the words at the bottom over the dark floor (a pool gradient from the bottom).
  X has no UI over the top; Reels does, so portrait keeps the words at the top.

**Pitfalls.** A radial gradient filled into a rectangle smaller than its radius leaves a hard edge (fill the whole circle's box). A sprite
already baked around its centroid must not be offset by the centroid again, or every piece collapses to the middle. The medallion's loose
half had to be displaced about 12% of its radius, with ±0.3 rad of rotation, before it read as "not gathered" at thumbnail size.
