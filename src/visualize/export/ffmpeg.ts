import { spawn } from 'node:child_process';

function run_ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    process.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    process.on('error', (error) => {
      reject(error);
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

export async function trim_video_to_webm(
  raw_video_path: string,
  output_webm_path: string,
  start_seconds: number,
  duration_seconds: number,
) {
  await run_ffmpeg([
    '-y',
    '-ss',
    start_seconds.toFixed(3),
    '-i',
    raw_video_path,
    '-t',
    duration_seconds.toFixed(3),
    '-r',
    '60',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuv420p',
    output_webm_path,
  ]);
}

export async function transcode_webm_to_mp4(
  input_webm_path: string,
  output_mp4_path: string,
) {
  await run_ffmpeg([
    '-y',
    '-i',
    input_webm_path,
    '-r',
    '60',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output_mp4_path,
  ]);
}

export function probe_video_duration_seconds(video_path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        video_path,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    process.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    process.on('error', reject);
    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }

      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration)) {
        reject(new Error('ffprobe 未返回有效视频时长。'));
        return;
      }

      resolve(duration);
    });
  });
}
