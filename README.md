# NRL IC-2730 Simulator

IC-2730 网页机头，可离线仿真，也可通过 NRL Link 操作配有 NRL2730 机身盒子的电台。网页含双段液晶、面板旋钮、HM-207 手咪、接收音频和按住发射。项目与 Icom、NRL Link 及盒子厂商无隶属关系。

项目作者 **BD1EMJ**（[GitHub · moface](https://github.com/moface)）。

## 快速开始

从 GitHub 下载源码，进入项目目录。需要 Python 3.11 或以上，无需安装 Python 或前端依赖包。

```sh
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
```

| 平台 | 命令 |
| --- | --- |
| Linux / macOS | `python3 -m softhead.server` |
| Windows PowerShell | `py -3 -m softhead.server` |

打开 `http://127.0.0.1:8787/softhead/`。无配置文件时是离线仿真。按 Ctrl+C 停止服务。

## 接入 NRL 实机

1. 将 `config.example.toml` 复制为 `config.toml`，设置 `[nrl]`。使用你自己的呼号、软机头 SSID、机身 SSID、NRL UDP 地址及端口，并设置 `enabled = true`。
2. 在 NRL 服务器上为软机头注册机型 14 的设备，并将它和机身加入同一房间。三个设备的 SSID 各自独立。如有设备鉴权，在 `[nrl]` 中填写 `password_file`。NRL 密码与网页登录密码独立。
3. 启动服务，打开 `/softhead/?mode=live`。点「联网」，或脱网时长按电源并确认「联网并开机」。
4. `hardware_panel_ssids` 配置硬机头编号。设置 `device_status_url` 可通过 NRL 的公开 `/device/get` 检查硬机头在线状态。未填写硬机头编号或查询接口不可用时，页面会提示无法确认在线状态，由你决定是否继续。避免在同一个房间让两个机头同时在线。
5. `allow_tx` 默认关闭。需要发射时启用该选项，在本机回环地址或 HTTPS 实机页按住 PTT。浏览器首次弹出麦克风权限时，松手并授权后再按。TX 指示以机身回显为准，失焦、断流、松手或达到配置上限会释放。

网页入口 `/softhead/` 是仿真，`/softhead/?mode=live` 是实机，`/softhead/debug/` 是调试页。机身关机并超过 `offline_idle_seconds` 未操作时，软机头会停止 NRL 心跳。关机时可提前设置音量和静噪，刷新网页恢复 VOL 5、SQL 15。

## HTTPS 远程访问

在 `[web]` 设置 `public_origin`（包含实际 HTTPS 端口），并配置 `tls_cert` 和 `tls_key`，或由反向代理终止 TLS 并设置 `trusted_proxies` 为代理连接后端时使用的来源 IP。反代应保留公网 Host、Origin、Cookie 和原始路径，关闭音频响应缓冲，读取超时至少 30 秒。参考 [Nginx 片段](deploy/nginx.conf.example)。网页鉴权使用 `[auth]` 的用户名和密码，建议通过 `password_file` 引用独立随机密码文件。配置文件中的相对路径以配置文件目录为准。

默认本机 HTTP 仅监听回环地址。若明确需要无鉴权的内网 HTTP，可配置精确的 `allowed_hosts`（包括端口），并用防火墙限定访问范围。浏览器麦克风需要可信 HTTPS 或本机回环地址。

## Docker 部署

发布后的部署从 GitHub 下载 Compose 文件和配置样例，容器从 GHCR 拉取。需要 Docker Compose v2。

```sh
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
mkdir -p config
cp config.example.toml config/config.toml
```

编辑 `config/config.toml`，把容器内的 `web.bind` 设为 `"0.0.0.0"`，`web.port` 保持为 `8787`。如果只从宿主机访问 HTTP，在 `allowed_hosts` 加入 `"127.0.0.1:8787"`，并保留 Compose 默认的宿主机回环绑定。远程部署按上一节配置 HTTPS。按需用 `SOFTHEAD_BIND` 和 `SOFTHEAD_PORT` 修改宿主机监听，用 `SOFTHEAD_UID` 和 `SOFTHEAD_GID` 选择能读取配置的非 root 用户。

在项目目录的 `.env` 写入镜像地址，再启动服务。首次发布后需在 GitHub Packages 确认镜像包可见性。公开镜像可以匿名拉取。

```sh
printf '%s\n' 'SOFTHEAD_IMAGE=ghcr.io/moface/nrl-ic-2730-simulator:latest' >> .env
docker compose pull softhead
docker compose up -d softhead
docker compose ps softhead
```

GitHub Actions 在默认分支推送后构建 AMD64 / ARM64 镜像。可从部署目录定期运行 `./deploy/update.sh`，软机头仍在联网时脚本会跳过更新。配置继续保存在挂载目录。也可把镜像固定到某个 `:sha-...` 或发布标签。

源码开发时，可以运行 `docker build -t nrl-ic-2730-simulator:local .`，并设置 `SOFTHEAD_IMAGE=nrl-ic-2730-simulator:local` 使用本地镜像。

## 开发

`softhead/` 是 Python 桥接，`web/` 是免构建的静态前端，`tests/` 是本地回环测试。运行 `python -m unittest discover -s tests`。真机功能以 NRL2730 兼容情况为准。仓库发布范围是程序和通用样例，固件、抓包、凭据和实际台站配置由部署者自行保管。
