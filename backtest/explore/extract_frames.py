import cv2, os, sys

src = r"C:\Users\57328\Desktop\IDM\下载.mp4"
out = r"C:\Users\57328\WorkBuddy\2026-08-08-10-06-33\frames"
os.makedirs(out, exist_ok=True)

cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
dur = total / fps if fps else 0
print(f"fps={fps} total_frames={total} duration={dur:.1f}s")

# extract ~12 evenly spaced frames
n = 12
step = max(1, total // n)
saved = []
idx = 0
while True:
    ret, frame = cap.read()
    if not ret:
        break
    if idx % step == 0 and len(saved) < n:
        p = os.path.join(out, f"frame_{idx:06d}.png")
        cv2.imwrite(p, frame)
        saved.append(p)
    idx += 1
cap.release()
print("SAVED", len(saved))
for s in saved:
    print(s)
