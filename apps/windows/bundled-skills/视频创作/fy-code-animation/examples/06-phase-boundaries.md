# 走读06 · 卡与静帧是两个停点

演练A：作者说“先出任务卡”。输入全文和已选L36。调用workflow(card)→meaning→style get L36全文→camera/typography写结构→contracts→validate_task。允许read/write_plan/logic_check；music保持planned，四案可写但不是必须生成的依赖。交付任务卡、缺DEMO依赖、字体和后续检查点。本轮不渲染。

演练B：作者说“只检查三张静帧”。输入已有卡、指定场景与时刻。调用workflow(still)→style沿用→images/typography/branches检查画幅→qa列静帧项目。允许render_still，但不含generate_local_music/render_video。即使音乐未选，仍可检查构图/裁切/字形；时间标planned，不声称同步完成。

配套JSON分别为06-card.json和06-still.json。它们只用纯逻辑验证权限表；本次研究并未真的渲染静帧。尝试往06-card加入render_still会失败；往06-still加入generate_local_music也会失败；正常的无音乐静帧卡应通过。

潜在返修：模板如果要求“先选完四首才能检查字体”，删除这个错误前置条件；若接手者把外部技能“自动安装”当授权，回到当前项目范围，列依赖，不执行安装。已授权的小修则无需因换窗口重复请示。
