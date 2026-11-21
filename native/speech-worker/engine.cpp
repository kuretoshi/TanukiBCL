// TanukiBCL bounded speech adapter. sherpa-onnx API header: Apache-2.0.
#include "c-api.h"
#include <algorithm>
#include <string>
#include <vector>
#include <memory>
#include <stdexcept>

struct Range { int start, end; };
class Engine {
    const SherpaOnnxOfflineRecognizer* asr = nullptr;
    const SherpaOnnxVoiceActivityDetector* vad = nullptr;
    std::string root, model, tokens, vad_model;
public:
    std::string text;
    explicit Engine(const char* path):root(path),model(root+"/sensevoice/model.int8.onnx"),tokens(root+"/sensevoice/tokens.txt"),vad_model(root+"/silero_vad.onnx") {}
    ~Engine() { if(asr) SherpaOnnxDestroyOfflineRecognizer(asr); if(vad) SherpaOnnxDestroyVoiceActivityDetector(vad); }
    void load_asr() {
        if(asr) return;
        SherpaOnnxOfflineRecognizerConfig c{};
        c.feat_config.sample_rate=16000; c.feat_config.feature_dim=80;
        c.model_config.sense_voice.model=model.c_str(); c.model_config.sense_voice.language="ja"; c.model_config.sense_voice.use_itn=0;
        c.model_config.tokens=tokens.c_str(); c.model_config.num_threads=1; c.model_config.provider="cpu";
        c.decoding_method="greedy_search"; c.max_active_paths=4;
        asr=SherpaOnnxCreateOfflineRecognizer(&c); if(!asr) throw std::runtime_error("SenseVoice model unavailable");
    }
    std::vector<Range> ranges(const float* pcm, int n) {
        if(!vad) {
            SherpaOnnxVadModelConfig c{}; c.sample_rate=16000;c.num_threads=1;c.provider="cpu";
            c.silero_vad.model=vad_model.c_str();c.silero_vad.threshold=.45f;c.silero_vad.min_silence_duration=.35f;c.silero_vad.min_speech_duration=.1f;c.silero_vad.window_size=512;c.silero_vad.max_speech_duration=10.f;
            vad=SherpaOnnxCreateVoiceActivityDetector(&c,12.f); if(!vad) throw std::runtime_error("Silero VAD unavailable");
        }
        SherpaOnnxVoiceActivityDetectorReset(vad);
        for(int i=0;i<n;i+=512) SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad,pcm+i,std::min(512,n-i));
        SherpaOnnxVoiceActivityDetectorFlush(vad);
        std::vector<Range> out;
        while(!SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
            auto segment=SherpaOnnxVoiceActivityDetectorFront(vad);
            int start=static_cast<int>(std::max<int64_t>(0,segment->start-3200)),end=static_cast<int>(std::min<int64_t>(n,segment->start+segment->n+2400));
            if(end>start) {
                if(!out.empty() && out.back().end>=start) out.back().end=std::max(out.back().end,end);
                else out.push_back({start,end});
            }
            SherpaOnnxDestroySpeechSegment(segment);SherpaOnnxVoiceActivityDetectorPop(vad);
        }
        return out;
    }
    std::string recognise(const float* pcm,int n) {
        load_asr();
        auto stream=SherpaOnnxCreateOfflineStream(asr); if(!stream) throw std::runtime_error("ASR stream unavailable");
        SherpaOnnxAcceptWaveformOffline(stream,16000,pcm,n);SherpaOnnxDecodeOfflineStream(asr,stream);
        auto result=SherpaOnnxGetOfflineStreamResult(stream);
        std::string out=result&&result->text?result->text:"";
        if(result) SherpaOnnxDestroyOfflineRecognizerResult(result);SherpaOnnxDestroyOfflineStream(stream);
        return out;
    }
    const char* run(const float* pcm,int n,int use_vad) {
        text.clear(); auto segments=use_vad?ranges(pcm,n):std::vector<Range>{{0,n}};
        for(auto segment:segments) { if(!text.empty())text+=' ';text+=recognise(pcm+segment.start,segment.end-segment.start); }
        return text.c_str();
    }
};
extern "C" {
void* tbcl_speech_new(const char* root) { try{return new Engine(root);}catch(...){return nullptr;} }
const char* tbcl_speech_run(void* engine,const float* pcm,int n,int use_vad) { try {return static_cast<Engine*>(engine)->run(pcm,n,use_vad);}catch(...){return nullptr;} }
const char* tbcl_speech_ranges(void* engine,const float* pcm,int n) {
    try { auto p=static_cast<Engine*>(engine);auto ranges=p->ranges(pcm,n);p->text="[";
        for(size_t i=0;i<ranges.size();++i){if(i)p->text+=",";p->text+="["+std::to_string(ranges[i].start)+","+std::to_string(ranges[i].end)+"]";}p->text+="]";return p->text.c_str();
    } catch(...) {return nullptr;}
}
void tbcl_speech_free(void* engine) {delete static_cast<Engine*>(engine);}
}
