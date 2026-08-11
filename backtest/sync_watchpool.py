# -*- coding: utf-8 -*-
"""同步上层权威 watchpool.json 到 backtest/data/。

合并后 data/watchpool.json 的唯一权威副本在上层（sustainable-dividend-watchpool/data/），
backtest/data/watchpool.json 是回测管道读取的副本。本脚本把上层副本同步到 backtest/data/，
确保回测用的是最新的股票池定义。

用法：
  python sync_watchpool.py          # 同步
  python sync_watchpool.py --check  # 仅检查是否一致（不同则退出码 1）
"""
import hashlib
import os
import sys
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
AUTHORITATIVE = os.path.join(HERE, "..", "data", "watchpool.json")
LOCAL_COPY = os.path.join(HERE, "data", "watchpool.json")


def _md5(path):
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def main():
    check_only = "--check" in sys.argv
    if not os.path.exists(AUTHORITATIVE):
        print(f"[错误] 上层权威 watchpool.json 不存在: {AUTHORITATIVE}")
        sys.exit(1)

    a_hash = _md5(AUTHORITATIVE)
    l_hash = _md5(LOCAL_COPY)

    if a_hash == l_hash:
        print(f"[OK] backtest/data/watchpool.json 与上层一致 (md5={a_hash[:12]})")
        return

    if check_only:
        print(f"[差异] 上层 md5={a_hash[:12]} vs backtest/data/ md5={l_hash[:12] if l_hash else '不存在'}")
        sys.exit(1)

    os.makedirs(os.path.dirname(LOCAL_COPY), exist_ok=True)
    shutil.copy2(AUTHORITATIVE, LOCAL_COPY)
    print(f"[同步] 上层 watchpool.json -> backtest/data/watchpool.json (md5={a_hash[:12]})")


if __name__ == "__main__":
    main()
