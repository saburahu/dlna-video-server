import fs from'node:fs/promises';import path from'node:path';import{execFileSync}from'node:child_process';
export const FFMPEG_HELP='FFmpeg/ffprobeは同梱されていません。https://www.gyan.dev/ffmpeg/builds/ からWindows x64の現行essentials/full buildを別途取得し、binフォルダをSetupで指定してください。推奨検証版8.1.2、最低7.1.2です。';
export function acceptableVersion(v){const m=/^ff(?:mpeg|probe) version (\d+)\.(\d+)(?:\.(\d+))?/.exec(v);if(!m)return false;const[a,b,c]=m.slice(1).map(x=>Number(x||0));return a>7||a===7&&(b>1||b===1&&c>=2);}
export function sameBuild(a,b){const fields=s=>[/^ff(?:mpeg|probe) version (\S+)/.exec(s)?.[1],/^built with (.+)$/m.exec(s)?.[1],/^configuration: (.+)$/m.exec(s)?.[1]];const x=fields(a),y=fields(b);return x.every((v,i)=>Boolean(v)&&v===y[i]);}
export async function externalFFmpeg(root,config={}){
 const directory=path.resolve(config.ffmpegDirectory??process.env.PT3_FFMPEG_DIR??path.join(root,'tools','ffmpeg','bin')),ffmpeg=path.join(directory,'ffmpeg.exe'),ffprobe=path.join(directory,'ffprobe.exe');
 for(const p of[ffmpeg,ffprobe])if(!(await fs.stat(p).catch(()=>undefined))?.isFile())throw Error(FFMPEG_HELP);
 const run=(f,a)=>execFileSync(f,a,{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024}),v=run(ffmpeg,['-version']),p=run(ffprobe,['-version']);
 if(!acceptableVersion(v)||!acceptableVersion(p))throw Error('古い/未判定のFFmpegです。'+FFMPEG_HELP);
 if(!sameBuild(v,p))throw Error('ffmpeg/ffprobeは同じビルドから配置してください');
 if(v.includes('--enable-nonfree'))throw Error('この配布経路ではnonfreeビルドを検証していません');
 const encoders=run(ffmpeg,['-hide_banner','-encoders']);for(const n of['libx264','mpeg2video','aac'])if(!new RegExp('\\b'+n+'\\b').test(encoders))throw Error('必要なencoderがありません: '+n);
 return{directory,ffmpeg,ffprobe,version:v.split(/\r?\n/)[0]};
}
