from setuptools import setup, find_namespace_packages

with open("cli_anything/mtbot_windows/README.md", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="cli-anything-mtbot-windows",
    version="1.0.0",
    description="CLI harness for MtBot Windows Assistant",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="MtBot",
    python_requires=">=3.10",
    packages=find_namespace_packages(include=["cli_anything.*"]),
    package_data={
        "cli_anything.mtbot_windows": ["skills/*.md"],
    },
    install_requires=[
        "click>=8.0.0",
        "prompt-toolkit>=3.0.0",
        "websocket-client>=1.0.0",
    ],
    entry_points={
        "console_scripts": [
            "cli-anything-mtbot-windows=cli_anything.mtbot_windows.mtbot_windows_cli:main",
        ],
    },
)
