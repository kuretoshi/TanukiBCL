"""Synthetic Japanese role-word comparison. Never records a physical microphone."""
import os,json,subprocess,base64,wave,io,ctypes,time,re
from pathlib import Path
root=Path(os.environ['LOCALAPPDATA'])/'TanukiBCL/Speech/sherpa-2.0.2';corpus=root.parent/'evaluation'
vosk=Path(os.environ.get('TANUKI_VOSK_ROOT', str(Path(__file__).resolve().parents[2].parent/'BetterCrewLink-Tauri-Beta/out/tauri-backend/rust-speech')))
if not (vosk/'libvosk.dll').exists():raise RuntimeError('Set TANUKI_VOSK_ROOT to the existing directory containing libvosk.dll and model/')
dlls=os.add_dll_directory(str(vosk));lib=ctypes.CDLL(str(vosk/'libvosk.dll'))
for name,args,result in [('vosk_set_log_level',[ctypes.c_int],None),('vosk_model_new',[ctypes.c_char_p],ctypes.c_void_p),('vosk_model_free',[ctypes.c_void_p],None),('vosk_recognizer_new',[ctypes.c_void_p,ctypes.c_float],ctypes.c_void_p),('vosk_recognizer_free',[ctypes.c_void_p],None),('vosk_recognizer_set_words',[ctypes.c_void_p,ctypes.c_int],None),('vosk_recognizer_accept_waveform',[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int],ctypes.c_int),('vosk_recognizer_result',[ctypes.c_void_p],ctypes.c_char_p),('vosk_recognizer_final_result',[ctypes.c_void_p],ctypes.c_char_p)]:
 f=getattr(lib,name);f.argtypes=args;f.restype=result
lib.vosk_set_log_level(-1);model=lib.vosk_model_new(str(vosk/'model').encode())
if not model:raise RuntimeError('Existing Vosk model unavailable')
p=subprocess.Popen([str(root/'runtime/TanukiSpeechWorker.exe'),str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
def wav(data):
 out=io.BytesIO()
 with wave.open(out,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(data)
 return out.getvalue()
sequence=0
def run(data,engine='sensevoice'):
 global sequence
 sequence+=1;p.stdin.write(json.dumps({'id':str(sequence),'maximum':12,'wav':base64.b64encode(wav(data)).decode(),'engine':engine})+'\n');p.stdin.flush()
 result=json.loads(p.stdout.readline())
 if 'error' in result:raise RuntimeError(result['error'])
 return result
def recognise(data):
 decoder=lib.vosk_recognizer_new(model,16000);lib.vosk_recognizer_set_words(decoder,1);texts=[];tokens=[]
 try:
  for at in range(0,len(data),4096):
   chunk=data[at:at+4096]
   if lib.vosk_recognizer_accept_waveform(decoder,chunk,len(chunk)):
    result=json.loads(lib.vosk_recognizer_result(decoder));texts.append(result.get('text',''));tokens.extend(result.get('result',[]))
  result=json.loads(lib.vosk_recognizer_final_result(decoder));texts.append(result.get('text',''));tokens.extend(result.get('result',[]))
 finally:lib.vosk_recognizer_free(decoder)
 return {'text':' '.join(texts).strip(),'tokens':tokens}
def memory():
 class Counters(ctypes.Structure):_fields_=[('cb',ctypes.c_ulong),('faults',ctypes.c_ulong),*[(n,ctypes.c_size_t) for n in ['peakWS','WS','peakPaged','paged','peakNonPaged','nonPaged','pagefile','peakPagefile','private']]]
 handle=ctypes.windll.kernel32.OpenProcess(0x410,False,p.pid);c=Counters();c.cb=ctypes.sizeof(c)
 try:ctypes.windll.psapi.GetProcessMemoryInfo(handle,ctypes.byref(c),c.cb)
 finally:ctypes.windll.kernel32.CloseHandle(handle)
 return {'workingSetMiB':round(c.WS/1048576,1),'privateMiB':round(c.private/1048576,1)}
report={'scope':'Synthetic Windows Japanese TTS; not real users or an in-game load benchmark','cases':[]}
try:
 for case in json.loads((corpus/'cases.json').read_text(encoding='utf-8-sig')):
  with wave.open(str(corpus/case['file'])) as w:data=w.readframes(w.getnframes())
  data=b'\0'*6400+data+b'\0'*16000
  start=time.perf_counter();old=recognise(data);old['ms']=round((time.perf_counter()-start)*1000)
  vad=run(data,'vad-only');start=time.perf_counter();filtered=recognise(b''.join(data[s*2:e*2]+b'\0'*16000 for s,e in vad['segments'])) if vad['segments'] else {'text':''}
  filtered['ms']=round((time.perf_counter()-start)*1000)+vad['ms'];new=run(data)
  row={**case,'seconds':len(data)/32000,'vosk':old,'vadVosk':filtered,'sensevoice':new};report['cases'].append(row)
  print(json.dumps({'expected':case['text'],'voice':case['voice'],'vosk':old['text'],'vadVosk':filtered['text'],'sensevoice':new['text'],'word':new.get('word'),'ms':new['ms']},ensure_ascii=True),flush=True)
 report['sensevoiceMemory']=memory()
 report['summary']={name:{'exact':sum(re.sub(r'[\s、。！？!?]','',c[name]['text'])==c['text'] for c in report['cases']),'total':len(report['cases']),'meanMs':round(sum(c[name]['ms'] for c in report['cases'])/len(report['cases']))} for name in ['vosk','vadVosk','sensevoice']}
 functions={'えー','ええ','えっと','あの','その','この','それ','これ','はい','うん','は','が','の','を','に','へ','と','で','も','ね','よ','です','ます','だ'}
 for c in report['cases']:
  c['expectedStoneWord']=c['text'].removesuffix('が来た')
  c['vosk']['stoneWord']=next((v['word'] for v in c['vosk'].get('tokens',[]) if v.get('conf',1)>=.55 and v['word']not in functions and 1<=len(v['word'])<=12 and all(ch.isalnum()or ch in 'ー々' for ch in v['word'])),None)
 for name,field in [('vosk','stoneWord'),('sensevoice','word')]:report['summary'][name]['correctStoneWords']=sum(c[name].get(field)==c['expectedStoneWord'] for c in report['cases'])
 out=Path('docs/local-speech-comparison.json');out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({k:v for k,v in report.items() if k!='cases'},ensure_ascii=True))
finally:
 p.stdin.close();p.wait(timeout=20);lib.vosk_model_free(model)
