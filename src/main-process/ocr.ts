import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * OCR 文字识别：调用系统内置引擎 —— Windows 走 WinRT OCR（经 PowerShell），
 * macOS 走 Vision 文字识别（经 osascript/JXA）。
 * 两平台均为系统自带、离线、零体积代价。每次识别 spawn 一个解释器
 * （macOS 全程约 0.2~0.6s，Windows 冷启约 0.5~1s），busy 期间拒绝并发。
 */

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]0x60 + '1' })[0]
function Await($WinRtTask, $ResultType) {
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($args[0])) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $ocr) { [Console]::Out.Write(''); return }
$result = Await ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[Console]::Out.Write((($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine))
`;

/**
 * JXA 调 Vision 的 VNRecognizeTextRequest。两个实测出来的坑写死在这：
 * - recognitionLevel 必须是 fast(0)：macOS 26/27 上 accurate(1) 的支持语言只剩
 *   6 门拉丁语言，中文会被当拉丁文硬认成乱码；fast 反而带 zh-Hans/zh-Hant 等
 *   33 门语言。语言列表须用 NSMutableArray 赋值，数组字面量不保证生效。
 * - JXA 桥里取候选的方法名是 `topCandidates`（ObjC 的
 *   topCandidatesWithMaxCandidates: 在桥里不存在）；枚举常量从 $. 取不可靠，
 *   一律赋原始数字。
 * Vision 在系统首次调用时有一次 30s+ 的模型初始化（之后常驻 <0.5s），
 * 因此 macOS 的超时给得更宽。
 */
const JXA_SCRIPT = `
ObjC.import('Vision')
function run(argv) {
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(
    $.NSURL.fileURLWithPath(argv[0]),
    $.NSDictionary.dictionary,
  )
  const req = $.VNRecognizeTextRequest.alloc.init
  req.recognitionLevel = 0
  const langs = $.NSMutableArray.alloc.init
  langs.addObject('zh-Hans')
  langs.addObject('en-US')
  req.recognitionLanguages = langs
  req.usesLanguageCorrection = true
  const err = $()
  if (!handler.performRequestsError($([req]), err)) {
    const msg = err.localizedDescription ? String(err.localizedDescription.js) : ''
    throw new Error('Vision 识别失败: ' + msg)
  }
  const out = []
  const results = req.results
  const n = parseInt(results.count, 10)
  for (let i = 0; i < n; i++) {
    const cands = results.objectAtIndex(i).topCandidates(1)
    if (parseInt(cands.count, 10) > 0) {
      out.push(ObjC.unwrap(cands.objectAtIndex(0).string))
    }
  }
  return out.join('\\n')
}
`;

const isMac = process.platform === 'darwin';

let scriptPath: string | null = null;

async function ensureScript(): Promise<string> {
  if (scriptPath) return scriptPath;
  const p = path.join(app.getPath('temp'), `screenshots-ocr.${isMac ? 'js' : 'ps1'}`);
  await fs.writeFile(p, isMac ? JXA_SCRIPT : PS_SCRIPT, 'utf8');
  scriptPath = p;
  return p;
}

export async function recognizeImagePng(png: Buffer): Promise<string> {
  const script = await ensureScript();
  const imgPath = path.join(app.getPath('temp'), `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await fs.writeFile(imgPath, png);
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        isMac ? 'osascript' : 'powershell.exe',
        isMac
          ? ['-l', 'JavaScript', script, imgPath]
          : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, imgPath],
        { windowsHide: true },
      );
      let out = '';
      let err = '';
      const timer = setTimeout(
        () => {
          child.kill();
          reject(new Error('OCR 超时'));
        },
        isMac ? 60000 : 20000,
      );
      child.stdout.on('data', (d: Buffer) => {
        out += String(d);
      });
      child.stderr.on('data', (d: Buffer) => {
        err += String(d);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        const text = out.replace(/^\uFEFF/, '').trim();
        if (code === 0) resolve(text);
        else reject(new Error(err.trim() || text || `OCR 进程退出码 ${code}`));
      });
    });
  } finally {
    fs.unlink(imgPath).catch(() => {});
  }
}
