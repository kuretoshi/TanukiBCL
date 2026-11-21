"""Download pinned upstream assets once into the TanukiBCL per-user speech cache."""
import hashlib,json,os,tarfile,urllib.request
from pathlib import Path
ROOT=Path(os.environ['LOCALAPPDATA'])/'TanukiBCL'/'Speech'/'sherpa-2.0.2'
ROOT.mkdir(parents=True,exist_ok=True)
HEADERS={'User-Agent':'TanukiBCL-local-speech-development'}
PINNED={
 'sherpa-onnx-v2.0.2-win-x64-shared-MD-MinSizeRel-no-tts-lib.tar.bz2':'fb3ef6cf2e65d03e44d3ff3ac5a8a1f3a1e2710416359f86d59525a1309bf8ce',
 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2':'7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',
 'silero_vad.onnx':'9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'}
def digest(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def get(url):
 with urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=60) as r:return r.read()
def asset(tag,name):
 return {'name':name,'browser_download_url':'https://github.com/k2-fsa/sherpa-onnx/releases/download/'+tag+'/'+name,'digest':'sha256:'+PINNED[name]}
def download(a):
 path=ROOT/a['name'];expected=PINNED[a['name']]
 if path.exists() and digest(path)==expected:return path
 temp=path.with_suffix(path.suffix+'.partial')
 with urllib.request.urlopen(urllib.request.Request(a['browser_download_url'],headers=HEADERS),timeout=60) as r,temp.open('wb') as w:
  while data:=r.read(1024*1024):w.write(data)
 actual=digest(temp)
 if actual!=expected:raise RuntimeError('Asset digest mismatch')
 temp.replace(path);print(a['name'],actual,flush=True)
 return path
runtime=asset('v2.0.2','sherpa-onnx-v2.0.2-win-x64-shared-MD-MinSizeRel-no-tts-lib.tar.bz2')
model=asset('asr-models','sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2')
vad=asset('asr-models','silero_vad.onnx')
for a,kind in [(runtime,'runtime'),(model,'sensevoice')]:
 target=ROOT/kind
 marker=target/'complete.json'
 if marker.exists():continue
 archive=download(a);target.mkdir(exist_ok=True)
 with tarfile.open(archive) as t:
  for member in t.getmembers():
   if not member.isfile():continue
   name=Path(member.name).name
   wanted=(kind=='runtime' and name.endswith(('.dll','.lib','.txt','.md'))) or (kind=='sensevoice' and name in ['model.int8.onnx','tokens.txt','LICENSE','README.md','ja.wav'])
   if not wanted:continue
   dest=target/name
   if dest.exists():raise RuntimeError('Duplicate archive basename: '+name)
   with t.extractfile(member) as r,dest.open('wb') as w:
    while chunk:=r.read(1024*1024):w.write(chunk)
 marker.write_text(json.dumps({'url':a['browser_download_url'],'upstreamDigest':a.get('digest'),'files':{p.name:digest(p) for p in target.iterdir() if p.is_file()}},indent=2),encoding='utf-8')
 archive.unlink() # This script's downloaded archive only; extracted shared assets remain.
 print(kind,[(p.name,p.stat().st_size) for p in target.iterdir()],flush=True)
if not (ROOT/'silero_vad.onnx').exists():download(vad)
for name,url in [('SHERPA-LICENSE','https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v2.0.2/LICENSE'),('SILERO-LICENSE','https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE'),('SENSEVOICE-MODEL-LICENSE','https://raw.githubusercontent.com/modelscope/FunASR/main/MODEL_LICENSE')]:
 p=ROOT/name
 if not p.exists():p.write_bytes(get(url))
print('READY',ROOT,flush=True)

notice=ROOT/'ONNXRUNTIME-LICENSE'
if not notice.exists():notice.write_bytes((Path(__file__).resolve().parents[1]/'native/speech-worker/ONNXRUNTIME-LICENSE').read_bytes())
