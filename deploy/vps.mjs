import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { REPO_ROOT, SSH_OPTS, fail, info, loadLocal, parseArgs, run, runInherit, saveLocal, step } from "./lib.mjs";

// 部署 VPS 容器：本机构建 → 传输镜像 → 远端 compose up → 健康检查 → 冒烟。
// 幂等：镜像 Id 一致即跳过传输；不上传/覆盖 VPS 上的 compose 与 .env。

const args = parseArgs(process.argv.slice(2));
const local = loadLocal();
const host = args.host || local.vps?.host || "";
const dir = args.dir || local.vps?.dir || "/opt/astra-gemini";
const project = args["verify-project"] || "demo";

if (!host) fail("缺少 --host（提供一次后缓存在 deploy/local.json）", 2);
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(project)) fail(`--verify-project 名称非法：${project}`, 2);

local.vps = { ...(local.vps || {}), host, dir };
saveLocal(local);

step("预检（本机 docker + 远端连通）");
const dv = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20000 });
if (dv.code !== 0) fail(`本机 docker 不可用：${(dv.stderr || dv.stdout).trim()}`);
info(`本机 docker ${dv.stdout.trim()}`);

const remote = await run("ssh", [...SSH_OPTS, host, `uname -m && docker version --format '{{.Server.Version}}' && test -d ${dir}`], { timeoutMs: 30000 });
if (remote.code !== 0) fail(`远端预检失败（${host}）：${(remote.stderr || remote.stdout).trim() || "无法连接"}`);
const rLines = remote.stdout.trim().split(/\r?\n/);
const uname = (rLines[0] || "").trim();
const platform = uname === "x86_64" ? "linux/amd64" : uname === "aarch64" ? "linux/arm64" : "";
if (!platform) fail(`不支持的远端架构：${uname || "未知"}`);
info(`远端 ${uname} → ${platform}，docker ${(rLines[1] || "").trim()}，目录 ${dir}`);

if (!args["skip-web-check"]) {
  const uiPath = path.join(REPO_ROOT, "src", "ui.html");
  const uiMtime = fs.existsSync(uiPath) ? fs.statSync(uiPath).mtimeMs : 0;
  const stale = [];
  const scan = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) scan(path.join(p, e));
    } else if (st.mtimeMs > uiMtime) {
      stale.push(p);
    }
  };
  for (const p of [path.join(REPO_ROOT, "web", "index.html"), path.join(REPO_ROOT, "web", "src")]) {
    if (fs.existsSync(p)) scan(p);
  }
  if (stale.length) {
    fail(`控制台源码比 src/ui.html 新，先运行 cd web && npm run build（或 --skip-web-check）；过期源文件：${path.relative(REPO_ROOT, stale[0])} 等 ${stale.length} 个`);
  }
}

step("检测远端 compose 文件");
const insp = await run("ssh", [...SSH_OPTS, host, `docker inspect astra-gemini --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`], { timeoutMs: 30000 });
let composeFiles = insp.stdout.trim().split(",").map((s) => s.trim()).filter(Boolean);
if (composeFiles.length) {
  info(`来自容器 label：${composeFiles.join(", ")}`);
} else {
  composeFiles = [`${dir}/docker-compose.yml`];
  const hostYml = await run("ssh", [...SSH_OPTS, host, `test -f ${dir}/docker-compose.host.yml`], { timeoutMs: 30000 });
  if (hostYml.code === 0) composeFiles.push(`${dir}/docker-compose.host.yml`);
  info(`回退默认：${composeFiles.join(", ")}`);
}
const composeCmd = `cd ${dir} && docker compose ${composeFiles.map((f) => `-f ${f}`).join(" ")} up -d --no-build`;

if (args["dry-run"]) {
  step("计划（dry-run，不做任何变更）");
  info(`docker build --platform ${platform} -t astra-gemini:local .`);
  info("对比本机与远端镜像 Id，相同则跳过传输");
  info(`否则：docker save | gzip | ssh ${host} 'gunzip | docker load'`);
  info(`ssh ${host} '${composeCmd}'`);
  info("等待 docker 健康检查 healthy（≤90s）");
  info(args["no-smoke"]
    ? "跳过冒烟（--no-smoke）"
    : `冒烟：ssh ${host} "docker exec astra-gemini node /app/docker/verify.mjs http://127.0.0.1:$PORT/mcp <token> ${project}"`);
  process.exit(0);
}

step(`构建镜像 astra-gemini:local（${platform}）`);
const buildCode = await runInherit("docker", ["build", "--platform", platform, "-t", "astra-gemini:local", "."], { cwd: REPO_ROOT });
if (buildCode !== 0) fail(`docker build 退出码 ${buildCode}`);

step("对比本机与远端镜像 Id");
const localId = (await run("docker", ["image", "inspect", "-f", "{{.Id}}", "astra-gemini:local"], { timeoutMs: 30000 })).stdout.trim();
const remoteId = (await run("ssh", [...SSH_OPTS, host, "docker image inspect -f '{{.Id}}' astra-gemini:local"], { timeoutMs: 30000 })).stdout.trim();
if (localId && localId === remoteId) {
  info("远端镜像已是最新，跳过传输");
} else {
  step("传输镜像到远端");
  await new Promise((resolve, reject) => {
    const save = spawn("docker", ["save", "astra-gemini:local"], { cwd: REPO_ROOT, windowsHide: true });
    const ssh = spawn("ssh", [...SSH_OPTS, host, "gunzip | docker load"], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    const gz = zlib.createGzip();
    let sent = 0;
    let lastLog = 0;
    gz.on("data", (chunk) => {
      sent += chunk.length;
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        info(`已传输 ${(sent / 1048576).toFixed(1)} MB`);
      }
    });
    save.stdout.pipe(gz).pipe(ssh.stdin);
    save.stderr.on("data", (d) => process.stderr.write(d));
    ssh.stdin.on("error", () => {});
    let saveCode = null;
    let sshCode = null;
    const done = () => {
      if (saveCode === null || sshCode === null) return;
      if (saveCode !== 0) return reject(new Error(`docker save 退出码 ${saveCode}`));
      if (sshCode !== 0) return reject(new Error(`远端 docker load 退出码 ${sshCode}`));
      info(`传输完成，共 ${(sent / 1048576).toFixed(1)} MB`);
      resolve();
    };
    save.on("close", (c) => { saveCode = c ?? -1; done(); });
    ssh.on("close", (c) => { sshCode = c ?? -1; done(); });
    save.on("error", reject);
    ssh.on("error", reject);
  }).catch((err) => fail(err.message));
}

step("远端启动容器");
const up = await run("ssh", [...SSH_OPTS, host, composeCmd], { timeoutMs: 120000 });
process.stdout.write(up.stdout);
process.stderr.write(up.stderr);
if (up.code !== 0) fail(`compose up 退出码 ${up.code}`);

step("等待健康检查（≤90s）");
const deadline = Date.now() + 90000;
let health = "";
while (Date.now() < deadline) {
  const h = await run("ssh", [...SSH_OPTS, host, "docker inspect -f '{{.State.Health.Status}}' astra-gemini"], { timeoutMs: 20000 });
  health = h.stdout.trim();
  if (health === "healthy") break;
  if (health === "unhealthy") fail("容器健康检查 unhealthy，请用 docker logs astra-gemini 排查");
  await new Promise((r) => setTimeout(r, 3000));
}
if (health !== "healthy") fail(`等待健康检查超时（最后状态：${health || "无"}）`);
info("容器 healthy");

if (!args["no-smoke"]) {
  step(`冒烟验证（项目 ${project}）`);
  const smoke = await run("ssh", [...SSH_OPTS, host,
    `docker exec astra-gemini sh -c 'node /app/docker/verify.mjs "http://127.0.0.1:\${PORT:-3939}/mcp" "$(cat /data/token.txt)" ${project}'`],
    { timeoutMs: 180000 });
  process.stdout.write(smoke.stdout);
  if (smoke.code !== 0) {
    process.stderr.write(smoke.stderr);
    fail(`冒烟失败（退出码 ${smoke.code}）`);
  }
}

step("部署完成");
