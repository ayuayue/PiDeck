# -*- coding: utf-8 -*-
import subprocess, numpy as np, os
proj = r"C:\Users\14012\pi-desktop-dev\video-series\promo-art"
p = os.path.join(proj, "output", "PiDeck-宣传片.mp4")
raw = subprocess.run(["ffmpeg","-v","error","-i",p,"-vf","fps=12,scale=320:-1,format=gray",
                      "-f","rawvideo","-pix_fmt","gray","-"], capture_output=True).stdout
n = 320*180
fr = np.frombuffer(raw, dtype=np.uint8)[:len(raw)//n*n].reshape(-1,180,320).astype(np.float32)
print("=== 审片 5 条必改项的复核 ===")
def band(t0, t1):
    seg = fr[int(t0*12):int(t1*12)]
    b = seg[:, :int(180*0.852), :]
    return b.mean(), b.mean(axis=(1,2)).min()

print()
print("必改1: 10-14s 纯黑空场")
m, mn = band(10, 14); print("  -> 字幕带以上亮度 mean=%.1f min=%.1f  (审片报 4-5)  %s" % (m, mn, "已修" if mn > 12 else "未修"))

print()
print("必改2: 37-42s 空场 + 虚线压字")
m, mn = band(37, 42); print("  -> 亮度 mean=%.1f min=%.1f  %s" % (m, mn, "已修" if mn > 12 else "未修"))

print()
print("必改3: 44.5-46.5s 大红框框空")
m, mn = band(44.5, 46.5); print("  -> 亮度 mean=%.1f min=%.1f  %s" % (m, mn, "已修" if mn > 12 else "未修"))

print()
print("必改4: 43-49s 画风发白")
m, mn = band(43, 49)
pre, _ = band(30, 40)
print("  -> 43-49s 亮度 mean=%.1f（30-40s 基准 %.1f） 差 %+.1f  %s" % (m, pre, m-pre, "已修" if m-pre < 12 else "未修"))

print()
print("必改5: 标注样式混用 / 标签贴边")
# 标签是浅米底（242,239,232）— 统计画面里接近纯浅色的像素占比
rgb = subprocess.run(["ffmpeg","-v","error","-i",p,"-vf","fps=2,scale=480:-1,format=rgb24",
                      "-f","rawvideo","-pix_fmt","rgb24","-"], capture_output=True).stdout
w, h = 480, 270
imgs = np.frombuffer(rgb, dtype=np.uint8)[:len(rgb)//(w*h*3)*(w*h*3)].reshape(-1,h,w,3).astype(np.int16)
light = (imgs[:,:,:,0] > 225) & (imgs[:,:,:,1] > 220) & (imgs[:,:,:,2] > 215)
print("  -> 浅色标签像素占比: mean=%.3f%% max=%.3f%%（每帧）" % (light.mean(axis=(1,2)).mean()*100, light.mean(axis=(1,2)).max()*100))
# 边缘条：检查画面最外 2 像素有没有大片浅色（= 标签贴边被裁）
border = np.concatenate([imgs[:, :2, :, :], imgs[:, -2:, :, :], imgs[:, :, :2, :], imgs[:, :, -2:, :]], axis=1)
bl = (border[:,:,:,0] > 225) & (border[:,:,:,1] > 220) & (border[:,:,:,2] > 215)
print("  -> 画面最外 2 像素里的浅色标签占比: mean=%.3f%% max=%.3f%%  %s" % (bl.mean()*100, bl.reshape(bl.shape[0],-1).mean(axis=1).max()*100, "无贴边" if bl.reshape(bl.shape[0],-1).mean(axis=1).max() < 2 else "有标签贴边"))
