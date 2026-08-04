# -*- coding: utf-8 -*-
"""第3篇：Pod才是K8s的最小调度单位 - 发布到小红书草稿箱"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp_publish import XiaohongshuPublisher

# 笔记风格配图（封面 + 3张内容图）
cover = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\03-re-cover_20260611_bdec3b62.png")
img_1 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\03-re-content-1_20260611_fdda4960.png")
img_2 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\03-re-content-2_20260611_a484a8a1.png")
img_3 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\03-re-content-3_20260611_a500b26f.png")

title = "03：Pod才是K8s的最小调度单位"

content = """你每次 k8s 跑一个 Pod，背后其实是一群容器在合租一个屋子🏠

Pod 不生产容器，只是容器搬运工～但它决定了这些容器怎么住、怎么活。

🧩 第一阶段：Pod = 共享空间的运行单元

Pod 不是一组容器的堆叠。它的核心定义是：一组共享网络命名空间和存储卷的容器集合。

✔️ 同 Pod 的容器共用一个 IP（localhost 互通）
✔️ 共享存储卷（Volume 共享数据）
✔️ 同生共死（一起启动、一起停止）

所以容器是打工仔，Pod 才是 K8s 真正的最小调度单位。

🔗 第二阶段：多容器 Pod 的两个经典玩法

▸ Sidecar 模式：主容器（Nginx）+ 辅助容器（Filebeat 采集日志），各司其职，共享同一 Pod。换助理不换老板，职责分离。

▸ Init Container：主容器启动前，先跑初始化容器完成配置/数据准备。必须全部成功退出，主容器才会启动。像开工前去行政领电脑、IT 装系统——一步步来。

🎯 第三阶段：为什么不直接用容器？

如果 K8s 最小单位是容器，两个容器要共享 IP 怎么办？依赖关系怎么管？

Pod 这个抽象层不是多余，是设计者精心选的"最小调度粒度"——把必须在一起的包在一起，把可以分开的留给调度器。

💡 设计哲学：最小团队单元

就像管理上不做"原子化个人"调度，而是做"团队单元"编排——共享上下文、同进同出、内部灵活。Pod 就是 K8s 里的这个团队。

一个 Pod 搞明白，K8s 50% 的设计理念就通了。

#K8s入门 #云原生 #kubernetes #程序员 #容器 #Pod #后端开发"""

if __name__ == "__main__":
    publisher = XiaohongshuPublisher()
    publisher.connect()

    if not publisher.check_login():
        print("[publish_03_v2] 登录检测失败，请先登录小红书")
        sys.exit(1)

    print("[publish_03_v2] 开始发布图文笔记（笔记风格配图）...")

    publisher.publish(
        title=title,
        content=content,
        image_paths=[cover, img_1, img_2, img_3],
    )

    print("[publish_03_v2] ✅ 图文笔记已填充到发布页")
