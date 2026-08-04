"""
Publish K8s article 2 (图文笔记模式) - connect to existing Edge browser
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp_publish import XiaohongshuPublisher

# Paths
WORKSPACE = r"C:\Users\Administrator\.mtbot-client\workspace"
ARTICLE_DIR = os.path.join(
    WORKSPACE,
    r"skills\内容创作与发布\xiaohongshu-content-pipeline\data\k8s-xhs-series\articles\02-kubectl-internals"
)
IMAGES_DIR = os.path.join(ARTICLE_DIR, "images")

# Read title
with open(os.path.join(IMAGES_DIR, "title.txt"), "r", encoding="utf-8") as f:
    title = f.read().strip()

# Read body - keep as a single string with proper paragraph structure
with open(os.path.join(IMAGES_DIR, "body.txt"), "r", encoding="utf-8") as f:
    content = f.read().strip()

# Image paths
image_paths = [
    os.path.join(IMAGES_DIR, "01-cover.png"),
    os.path.join(IMAGES_DIR, "02-content-1.png"),
    os.path.join(IMAGES_DIR, "03-content-2.png"),
    os.path.join(IMAGES_DIR, "04-content-3.png"),
    os.path.join(IMAGES_DIR, "05-content-4.png"),
    os.path.join(IMAGES_DIR, "06-content-5.png"),
    os.path.join(IMAGES_DIR, "07-content-6.png"),
]

# Connect to existing Edge via CDP
publisher = XiaohongshuPublisher(host="127.0.0.1", port=9222)

try:
    publisher.connect()
    publisher.publish(
        title=title,
        content=content,
        image_paths=image_paths,
    )
    print("\n[DONE] Article 2 has been filled into Xiaohongshu图文笔记 editor.")
except Exception as e:
    print(f"\n[ERROR] {e}")
    import traceback
    traceback.print_exc()
finally:
    publisher.disconnect()
