# 本机音乐适配契约

适配对象是本机ACE-Step 1.5已有脚本，路径由项目配置传入，不随技能附模型、运行环境或私人录音。当前项目研究核到版本1.5.0及现有解释器/检查点路径，但本轮没有加载模型、生成或试听。

已有脚本形状：`python acestep_gen.py SPEC.json OUT_DIR`。SPEC示意：

```json
{"caption":"完整英文器乐方案；预计段落仅作意图","duration":32,"bpm":92,"keyscale":"D minor","timesignature":"4","seeds":[11],"thinking":true,"steps":8,"shift":3.0,"offload":false}
```

确认支持caption、duration、bpm、keyscale、timesignature、seeds、thinking、steps、shift、offload、dit/lm选择；当前脚本guidance_scale写死1.0，lyrics固定器乐，WAV输出。没有逐镜头时间码/事件列表输入。LM失败可降级、可能改写caption；记录实际日志，不把提示词当执行保证。环境变量ACE_MAX_NEW会限制新生成数量，遇到输出不足先查日志与已有文件，不盲目重跑。

四案使用四份不同SPEC与输出目录，每个可先一个seed；只有作者授权试听生成时才调用。输出generation.json的参数/哈希与音频一起保留；作者选定具体文件后测量实际时长/节奏。seed仅是条件之一，不保证跨版本/GPU逐样本相同。

此接口只负责音乐。不得把声音克隆请求转到Renoise/MiMo云接口；用户私人录音与克隆身份按项目本机规则。无授权时只交提示词/配置/执行说明。

注意：现有脚本按seed复用已有输出，修改caption需使用新目录。generation.json里outputs.seconds记录生成耗时，不是音频实际时长；实际时长从解码/采样数读取。完整方法见 [音乐与音效](../recipes/music-and-sound.md)。
