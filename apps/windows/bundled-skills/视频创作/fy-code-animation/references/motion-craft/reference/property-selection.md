> 使用范围：UI与短段动效的参数配方。先读 ../../../modules/motion.md。下文的时长、数量、强度与人格表是设计起点，不是全类型硬性门槛；静止、线性、同步运动、无背景层都可有意采用。总时长含错峰，px按设计坐标换算，ms按实际fps换算。

# Property Selection



## Position



| Direction | Meaning |
|-----------|---------|
| Upward | Growth, improvement, aspiration |
| Downward | Settling, completion, grounding |
| Leftward | Regression, backward, departure |
| Rightward | Progression, forward, arrival |
| Toward center | Focus, convergence |
| Away from center | Distribution, expansion |



## Scale



| Direction | Meaning |
|-----------|---------|
| Scale up | Importance, activation, proximity |
| Scale down | Deprioritization, distance |
| Pulse | Attention, heartbeat, life |
| Breathing | Presence, waiting |



## Rotation



| Range | Meaning |
|-------|---------|
| Small (5-15°) | Subtle adjustment |
| Medium (45-90°) | Transformation |
| Full (360°) | Completion, processing |
| Continuous | Ongoing activity |



## Opacity



| Direction | Meaning |
|-----------|---------|
| Fade in | Arrival, enablement |
| Fade out | Departure, disablement |
| Partial | Secondary, disabled state |



For an important state change, make the new meaning explicit with wording, shape or position; opacity alone is acceptable when the state remains unambiguous.



## Color



| Transition | Meaning |
|-----------|---------|
| To green | Success, go |
| To red | Error, stop |
| To blue | Trust, active |
| To gray | Disabled, inactive |
| Brightening | Activation, focus |
| Dimming | Deactivation, background |



## Combined Properties



| Combination | Best For |
|-------------|----------|
| Position + Opacity | Content appearing/disappearing |
| Scale + Opacity | Cards, modals, notifications |
| Position + Scale | Selected items, focused content |
| Rotation + Scale | Celebrations, playful activation |
| Position + Rotation | Organic transitions |
| Color + Scale | State emphasis |



Primary property carries meaning; secondary adds polish. Two properties is the sweet spot.



## Property Selection by Goal



| Goal | Primary | Secondary | Avoid |
|------|---------|-----------|-------|
| Entrance | position | opacity | rotation |
| Exit | position | opacity | scale up |
| Button press | scale | color | position |
| Hover | scale or color | opacity | position |
| Success | scale | color + opacity | position |
| Error | position (shake) | color | scale |
| Loading | rotation | opacity | position |
| Toggle | position | color | rotation |
| Notification | position + scale | opacity | rotation |
| Delete | scale + opacity | position | grow |
| Selection | scale | color, opacity | rotation |
| Progress | position or scale | color | opacity |



## Performance



| Property | Performance |
|----------|-------------|
| transform (translate, scale, rotate) | Excellent — GPU-accelerated |
| opacity | Excellent — GPU-accelerated |
| color / background-color | Good — triggers paint |
| clip-path | Good — GPU on modern browsers |
| width / height | Poor — triggers layout |
| margin / padding | Poor — triggers layout |
| box-shadow | Poor — expensive paint |



Prefer transform/opacity where they express the intended change; profile layout, paint and compositing in the actual renderer. A shader, graph or frame renderer has a different cost model.

