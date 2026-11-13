# NRL IC-2730 Simulator

IC-2730 网页机头，可离线仿真，也可通过 NRL Link 操作配有 NRL2730 机身盒子的电台。网页含双段液晶、面板旋钮、HM-207 手咪、接收音频和按住发射。项目与 Icom、NRL Link 及盒子厂商无隶属关系。

项目作者 **BD1EMJ**（[GitHub · moface](https://github.com/moface)）。

## 选择部署方式

- [Docker 一键部署](#docker-一键部署)
- [Linux 命令行](#linux-命令行)
- [macOS 命令行](#macos-命令行)
- [Windows 命令行](#windows-命令行)

### Docker 一键部署

需要 Git、Docker 和 Docker Compose v2。以下命令在 Linux、macOS 或 Windows 的 WSL 终端运行。Docker 必须能从该终端连接。

```sh
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
./deploy/install.sh
```

脚本首次生成 `config/config.toml`，拉取 GHCR 的 AMD64 或 ARM64 镜像并启动容器。已有配置会保留。默认从 Docker 宿主机访问 [仿真页](http://127.0.0.1:8787/softhead/)，实机连接默认关闭。

修改配置后运行 `docker compose restart softhead`。查看日志用 `docker compose logs --tail=100 softhead`，停止用 `docker compose stop softhead`。更新可运行 `./deploy/update.sh`，软机头联网时会跳过。配置保存在挂载目录中。可通过环境变量 `SOFTHEAD_IMAGE` 固定镜像标签。

### Linux 命令行

使用发行版软件包管理器安装 Git 和 Python 3.11 或以上，先用 `python3 --version` 检查版本。

```sh
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
python3 -m softhead.server
```

### macOS 命令行

从 [Python 官网](https://www.python.org/downloads/macos/)安装 Python 3.11 或以上。若系统提示安装 Git 所需的命令行工具，完成安装后继续。

```sh
python3 --version
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
python3 -m softhead.server
```

### Windows 命令行

从 [Python 官网](https://www.python.org/downloads/windows/)安装 Python 3.11 或以上，并安装 [Git for Windows](https://git-scm.com/download/win)。新开 PowerShell 执行：

```powershell
py -3 --version
git clone https://github.com/moface/nrl-ic-2730-simulator.git
Set-Location nrl-ic-2730-simulator
py -3 -m softhead.server
```

三种命令行部署都无需安装额外 Python 包。启动后打开 [仿真页](http://127.0.0.1:8787/softhead/)，按 Ctrl+C 停止。也可从 GitHub 下载 ZIP 并解压，再进入解压后的目录执行启动命令。

## 接入 NRL 实机

1. 命令行部署将 `config.example.toml` 复制为项目根目录的 `config.toml`，Docker 部署编辑 `config/config.toml`。设置 `[nrl]`。使用你自己的呼号、软机头 SSID、机身 SSID、NRL UDP 地址及端口，并设置 `enabled = true`。
2. 在 NRL 服务器上为软机头注册机型 14 的设备，并将它和机身加入同一房间。三个设备的 SSID 各自独立。如有设备鉴权，在 `[nrl]` 中填写 `password_file`。NRL 密码与网页登录密码独立。
3. 启动服务，打开 `/softhead/?mode=live`。点「联网」，或脱网时长按电源并确认「联网并开机」。
4. `hardware_panel_ssids` 配置硬机头编号。设置 `device_status_url` 可通过 NRL 的公开 `/device/get` 检查硬机头在线状态。未填写硬机头编号或查询接口不可用时，页面会提示无法确认在线状态，由你决定是否继续。避免在同一个房间让两个机头同时在线。
5. `allow_tx` 默认关闭。需要发射时启用该选项，在本机回环地址或 HTTPS 实机页按住 PTT。浏览器首次弹出麦克风权限时，松手并授权后再按。TX 指示以机身回显为准，失焦、断流、松手或达到配置上限会释放。

网页入口 `/softhead/` 是仿真，`/softhead/?mode=live` 是实机，`/softhead/debug/` 是调试页。机身关机并超过 `offline_idle_seconds` 未操作时，软机头会停止 NRL 心跳。关机时可提前设置音量和静噪，刷新网页恢复 VOL 5、SQL 15。

## HTTPS 远程访问

在 `[web]` 设置 `public_origin`（包含实际 HTTPS 端口），并配置 `tls_cert` 和 `tls_key`，或由反向代理终止 TLS 并设置 `trusted_proxies` 为代理连接后端时使用的来源 IP。反代应保留公网 Host、Origin、Cookie 和原始路径，关闭音频响应缓冲，读取超时至少 30 秒。参考 [Nginx 片段](deploy/nginx.conf.example)。网页鉴权使用 `[auth]` 的用户名和密码，建议通过 `password_file` 引用独立随机密码文件。配置文件中的相对路径以配置文件目录为准。

默认本机 HTTP 仅监听回环地址。若明确需要无鉴权的内网 HTTP，可配置精确的 `allowed_hosts`（包括端口），并用防火墙限定访问范围。浏览器麦克风需要可信 HTTPS 或本机回环地址。

Docker 远程部署时，在 `config/config.toml` 设置 HTTPS 相关选项。使用反代时，应让后端端口只对代理可达。若需修改宿主机监听，可设置 `SOFTHEAD_BIND` 和 `SOFTHEAD_PORT`。容器内端口保持 `8787`，对外 HTTPS 端口由反代决定。若映射到其他本地 HTTP 端口，也要在 `allowed_hosts` 加入实际访问的 Host 和端口。挂载配置和密码文件必须能由容器的非 root 用户读取，可用 `SOFTHEAD_UID` 和 `SOFTHEAD_GID` 调整。

## 开发

`softhead/` 是 Python 桥接，`web/` 是免构建的静态前端，`tests/` 是本地回环测试。运行 `python -m unittest discover -s tests`。真机功能以 NRL2730 兼容情况为准。仓库发布范围是程序和通用样例，固件、抓包、凭据和实际台站配置由部署者自行保管。

从源码构建本地镜像可运行 `docker build -t nrl-ic-2730-simulator:local .`，再用 `SOFTHEAD_IMAGE=nrl-ic-2730-simulator:local docker compose up -d` 启动已有配置。

## 接收降噪与更新日志

接收降噪使用 SpeexDSP。Docker 镜像已包含该库。直接运行 Python 时，可在 Debian 或 Ubuntu 安装 `libspeexdsp1`，在 macOS 用 `brew install speexdsp`，或在 Windows 通过 Docker 使用降噪。缺少该库时，网页会继续播放原始接收音频。

版本变更见 [更新日志](CHANGELOG.md)。
