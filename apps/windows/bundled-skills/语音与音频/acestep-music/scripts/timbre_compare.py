# -*- coding: utf-8 -*-
import os, sys, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, r"E:\ai")
import numpy as np
import soundfile as sf
from scipy.fftpack import dct

def load(path, sr=22050, max_dur=30):
    y, orig = sf.read(path, dtype="float32")
    if y.ndim > 1: y = y.mean(axis=1)
    if orig != sr:
        n = int(len(y) * sr / orig)
        y = np.interp(np.linspace(0, len(y)-1, n), np.arange(len(y)), y)
    y = y[: int(sr*max_dur)]
    env = np.abs(y); thr = env.max()*0.02
    idx = np.where(env > thr)[0]
    if len(idx): y = y[idx[0]: idx[-1]+1]
    return y, sr

def mel_filter(n_mels=40, n_fft=2048, sr=22050):
    hz2mel = lambda h: 2595*np.log10(1+h/700)
    mel2hz = lambda m: 700*(10**(m/2595)-1)
    pts = mel2hz(np.linspace(hz2mel(0), hz2mel(sr/2), n_mels+2))
    bins = np.floor((n_fft+1)*pts/sr).astype(int)
    fb = np.zeros((n_mels, n_fft//2+1))
    for i in range(1, n_mels+1):
        l,c,r = bins[i-1], bins[i], bins[i+1]
        if c==l: c=l+1
        if r==c: r=c+1
        for k in range(l, min(c, fb.shape[1])): fb[i-1,k]=(k-l)/(c-l)
        for k in range(c, min(r, fb.shape[1])): fb[i-1,k]=(r-k)/(r-c)
    return fb

def feat(path, n_mfcc=20, n_fft=2048, hop=512):
    y, sr = load(path)
    fb = mel_filter(40, n_fft, sr)
    frames=[]
    for i in range(0, len(y)-n_fft, hop):
        w = y[i:i+n_fft]*np.hamming(n_fft)
        spec = np.abs(np.fft.rfft(w))**2
        mel = np.log(fb@spec + 1e-10)
        frames.append(dct(mel, type=2, norm="ortho")[:n_mfcc])
    m = np.array(frames); d = np.diff(m, axis=0)
    return np.concatenate([m.mean(0), m.std(0), d.mean(0), d.std(0)])

cos = lambda a,b: float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)))
dist = lambda a,b: float(np.linalg.norm(a-b)/np.sqrt(len(a)))

REF = r"E:\testsoft\Lumii-data\outputs\ace-step-1.5\audio\欢乐可爱动感-中文女声-40s.flac"
D = r"E:\ai\gradio_outputs\consistency"
fr = feat(REF)
print(f"{'对比':30} {'余弦':>8} {'距离':>8}")
print("-"*50)
for name in ["A-jazz","B-rock","C-cover-jazz"]:
    p = os.path.join(D, name+".flac")
    if not os.path.exists(p): continue
    f = feat(p)
    print(f"{'原始 ↔ '+name:30} {cos(fr,f):>8.4f} {dist(fr,f):>8.2f}")
fa = feat(os.path.join(D,"A-jazz.flac"))
fb = feat(os.path.join(D,"B-rock.flac"))
fc = feat(os.path.join(D,"C-cover-jazz.flac"))
print("-"*50)
print(f"{'A(爵士) ↔ C(cover)':30} {cos(fa,fc):>8.4f} {dist(fa,fc):>8.2f}")
print(f"{'B(摇滚) ↔ C(cover)':30} {cos(fb,fc):>8.4f} {dist(fb,fc):>8.2f}")
