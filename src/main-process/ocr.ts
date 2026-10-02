import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * OCR 文字识别：Windows 内置 WinRT OCR（Windows.Media.Ocr）。
 * 经 PowerShell 调用 —— 系统自带、离线、中文识别质量好、零体积代价。
 * 每次识别 spawn 一个 PowerShell（冷启约 0.5~1s），busy 期间拒绝并发。
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

let scriptPath: string | null = null;

async function ensureScript(): Promise<string> {
  if (scriptPath) return scriptPath;
  const p = path.join(app.getPath('temp'), 'screenshots-ocr.ps1');
  await fs.writeFile(p, PS_SCRIPT, 'utf8');
  scriptPath = p;
  return p;
}

export async function recognizeImagePng(png: Buffer): Promise<string> {
  const script = await ensureScript();
  const imgPath = path.join(
    app.getPath('temp'),
    `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  await fs.writeFile(imgPath, png);
  try {
    return await new Promise<string>((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          imgPath,
        ],
        { windowsHide: true },
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        ps.kill();
        reject(new Error('OCR 超时'));
      }, 20000);
      ps.stdout.on('data', (d: Buffer) => {
        out += String(d);
      });
      ps.stderr.on('data', (d: Buffer) => {
        err += String(d);
      });
      ps.on('error', reject);
      ps.on('exit', (code) => {
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
