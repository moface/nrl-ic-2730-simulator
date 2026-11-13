# 开源发布｜用浏览器当 IC-2730 的远程机头

我是 BD1EMJ。我做了一个 IC-2730 网页机头，可以在浏览器里操作左右双段液晶、面板旋钮和 HM-207 手咪。只想体验界面，可以直接运行离线仿真。有 IC-2730 和兼容的 NRL2730 机身盒子，也可以通过 NRL Link 接入实机。

## 目前能用什么

- 双段频率和存储信道显示，支持 MAIN、TX、BUSY、MR、SKIP 等回显，以及 25／50／75 小尾标。
- 支持开关机、左右调谐、音量和静噪。长按旋钮的一侧可以连续调节。
- 浏览器接收音频。实机发射需要显式启用，PTT 按住采集麦克风，松手停止。
- 软机头可手动联网和脱网。配置了在线查询接口时，联网前会提示硬机头状态，方便在两种机头之间切换。

## 从哪里开始

[GitHub 源码与使用手册](https://github.com/moface/nrl-ic-2730-simulator)

### 命令行部署（Linux、macOS、Windows）

安装 Python 3.11 或以上，从 GitHub 下载源码并进入项目目录。程序无需安装额外的 Python 包。

```sh
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
```

Linux 或 macOS 运行 `python3 -m softhead.server`，Windows PowerShell 运行 `py -3 -m softhead.server`。打开 [本机仿真页](http://127.0.0.1:8787/softhead/) 就能体验。接实机时，把 `config.example.toml` 复制为项目目录下的 `config.toml`，编辑后重启服务。

### Docker 部署

需要 Docker Compose v2。从同一个 GitHub 仓库获取 Compose 文件和配置样例。GHCR 镜像发布后，可直接拉取 AMD64 或 ARM64 镜像。

```sh
git clone https://github.com/moface/nrl-ic-2730-simulator.git
cd nrl-ic-2730-simulator
mkdir -p config
cp config.example.toml config/config.toml
```

编辑 `config/config.toml`，在 `[web]` 中设置 `bind = "0.0.0.0"`，端口保持 `8787`。从宿主机本地体验时，把 `allowed_hosts` 设为 `["127.0.0.1:8787"]`。然后在项目目录的 `.env` 加入以下一行。

```dotenv
SOFTHEAD_IMAGE=ghcr.io/moface/nrl-ic-2730-simulator:latest
```

```sh
docker compose pull softhead
docker compose up -d softhead
```

默认只在宿主机本地开放，可打开同一个 [仿真页](http://127.0.0.1:8787/softhead/)。从其他电脑远程访问时，请按手册配置 HTTPS、网页账号和反代。可以定期运行 `./deploy/update.sh` 拉取新版镜像，软机头仍在联网时会跳过更新。[Docker 与 HTTPS 部署手册](https://github.com/moface/nrl-ic-2730-simulator#docker-部署)

### 接入实机

在自己的 NRL 服务器登记软机头设备，并与机身放在同一房间。在部署方式对应的 `config.toml` 中配置 NRL 服务器、呼号和各设备 SSID，设置 `[nrl]` 的 `enabled = true`。重启服务后打开 `/softhead/?mode=live`，点击「联网」。仿真模式开箱可用，实机发射默认关闭。

如果你愿意帮忙验证，欢迎在 GitHub Issues 附上电台型号、盒子固件版本、NRL Link 版本和复现步骤。尤其想了解不同固件下的开机回显、菜单和扫描显示是否一致。发截图前请遮住密码、令牌和私有地址。

项目采用 MIT 许可证，由爱好者开发，与 Icom、NRL Link 及盒子厂商无隶属关系。
