"""
K8s入门 第2篇 - kubectl apply执行流程
图文笔记模式：每张图配一段文字
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp_publish import XiaohongshuPublisher

# 笔记风格配图（封面 + 6张内容图）
cover = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_52aa1cfc.png")
img_1 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_3cc22bfc.png")
img_2 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_985c8d27.png")
img_3 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_51255e5d.png")
img_4 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_8906df59.png")
img_5 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_4f99595b.png")
img_6 = os.path.abspath(r"C:\Users\Administrator\.mtbot-client\workspace\outputs\20260611\generated_d90c8367.png")

title = "一个kubectl apply背后站着6个打工仔🏃"

content = (
    "你每次 kubectl apply -f deployment.yaml，背后有 6 个组件像接力赛一样协同工作。面试问「简述 kubectl apply 流程」，答不到这 6 步基本凉了。\n\n"
    "🏃 第一棒 · API Server（银行前台）\n"
    "认证你是谁、检查权限够不够、验证 yaml 格式。三关过了才记录请求。它是唯一入口，所有人找它。\n\n"
    "🏃 第二棒 · etcd（数据中心保险柜）\n"
    "唯一数据存储层，Pod、Service 等集群状态全存这里。分布式、高可用，内部用 Raft 保一致。只有 API Server 能读写它。\n\n"
    "🏃 第三棒 · Scheduler（房产中介）\n"
    "几十台 Node 选谁？先 filter 过滤不合格的，再 score 打分排序，最高分中选。这叫谓词-优先级调度。\n\n"
    "🏃 第四棒 · kubelet（工地包工头）\n"
    "收到通知后干苦力：拉镜像、建容器、挂存储、配网络。盯着 Pod 保活，崩了重拉、超限杀掉。这就是「声明式」精髓。\n\n"
    "🏃 第五棒 · Controller Manager（巡检员）\n"
    "检查集群实际状态和期望状态有无偏差。声明 3 个副本挂了 1 个，它就补 1 个。这叫控制循环（control loop）。\n\n"
    "🏃 第六棒 · kube-proxy（交通指挥员）\n"
    "把 Service 虚拟 IP 翻译成 Pod IP 搞转发。默认 iptables 模式，流量均匀分到后端 Pod。\n\n"
    "🎯 六棒接力：kubectl → API Server 认证 → etcd 存状态 → Scheduler 选节点 → kubelet 拉容器 → Controller Manager 纠偏差 → kube-proxy 管网络。理解了它，K8s 架构看懂一半。\n\n"
    "#K8s入门 #云原生 #kubernetes #程序员 #架构设计 #后端开发 #DevOps"
)

if __name__ == "__main__":
    publisher = XiaohongshuPublisher()
    publisher.connect()

    if not publisher.check_login():
        print("[publish_02] 登录检测失败，请先登录小红书")
        sys.exit(1)

    print("[publish_02] 开始发布图文笔记（笔记风格配图）...")

    publisher.publish(
        title=title,
        content=content,
        image_paths=[cover, img_1, img_2, img_3, img_4, img_5, img_6],
    )

    print("[publish_02] ✅ 图文笔记已填充到发布页，请在浏览器中检查后手动发布")
