# PiDeck 打包产物启动冒烟用的最小 Linux 环境。
#
# 为什么需要镜像而不只是 WSL：本镜像刻意停在 Debian 12（glibc 2.36）而不是最新版，
# 这样 `ldd` 报出来的缺失库、`objdump` 报出来的 GLIBC 符号需求，都接近统信 UOS 20 /
# 麒麟 V10（glibc 2.28）那一类「装了打不开」的用户机器；宿主是 Windows 也能跑。
#
# 为什么写死 http 镜像源：本机网络对 deb.debian.org 走 HTTP 会拿到 502（代理拦截），
# 走 HTTPS 又因 slim 镜像没有 ca-certificates 而无法校验证书。mirrors.aliyun.com 的
# HTTP 通道实测可通。换环境跑不通时，把 URIs 换成你能通的镜像即可。
#
# 构建（上下文就是本目录，无源码依赖）：
#   docker build -t pideck-boot-smoke scripts/boot-smoke
# 运行：
#   docker run --rm -v "/c/Users/<you>/AppData/Local/Temp:/artifacts:ro" \
#     -v "/d/project/github/pi-desktop:/repo:ro" pideck-boot-smoke \
#     /artifacts/PiDeck_0.9.0_amd64.deb
FROM node:24-bookworm-slim

# 镜像源可换：`docker build --build-arg DEBIAN_MIRROR=mirrors.ustc.edu.cn ...`
# 大包（Xvfb 依赖的 mesa/libllvm15 约 90MB）在某些镜像站会断流，换源比重试管用。
ARG DEBIAN_MIRROR=mirrors.aliyun.com

RUN printf 'Types: deb\nURIs: http://%s/debian\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://%s/debian-security\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "${DEBIAN_MIRROR}" "${DEBIAN_MIRROR}" > /etc/apt/sources.list.d/debian.sources \
	&& apt-get update -qq -o Acquire::Retries=3 \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends -o Acquire::Retries=3 \
	# 冒烟工具链
	xvfb xauth binutils dpkg \
	# Electron 运行时库：缺任一个都是「双击没反应」的直接原因
	libgtk-3-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
		libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
		libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
	# GTK 文件选择框没有主题会刷一屏告警，干扰日志判读
	libglib2.0-0 ca-certificates fonts-dejavu-core \
	&& rm -rf /var/lib/apt/lists/*

# 产物所在目录挂到 /artifacts，仓库挂到 /repo（只读即可，脚本不写仓库）。
# ENTRYPOINT 以 `--artifact` 结尾：`docker run 镜像 /artifacts/xxx.deb` 追加的参数正好补上值，
# 中间不过 shell，路径里带空格或引号也不会被拆。
WORKDIR /repo
ENTRYPOINT ["/usr/bin/xvfb-run", "-a", "node", "/repo/scripts/packaged-boot-smoke.js", "--artifact"]
CMD ["/artifacts/PiDeck-amd64.AppImage"]
