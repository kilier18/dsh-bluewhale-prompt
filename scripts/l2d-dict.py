# -*- coding: utf-8 -*-
"""把官方 motion3 动作库拆成「给 agent 用的语义字典」。

用法（在仓库根目录跑；python 要 3.8+，Windows 上用自己那套能跑的）：
  python scripts/l2d-dict.py                      # 默认：读 .motions-lib，写 dict/
  python scripts/l2d-dict.py --lib "D:/xx/lib" --out dict/l2d-motion-dict.json \
      --md dict/l2d-motion-dict.md --mapping dict/l2d-motion-mapping.json

输入：`scripts/pull-motions.mjs` 从桌宠 OPFS 拉下来的官方 44 条 motion3。
输出：① 瘦身 JSON（插件运行时读）② 全量 JSON ③ Markdown ④ 给 LLM 的速查卡（由 gen-prompt.mjs 生成）。
"""
import argparse
import json
import os
import glob
import sys

FPS = 60.0
BIN = 1.0 / FPS

HEAD = {'AngleX', 'AngleY', 'AngleZ'}
GAZE = {'ParamEyeBallX', 'ParamEyeBallY'}
BODY = {'PositionX', 'PositionY', 'PositionZ', 'LeanInput', 'ShoulderX',
        'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
        'ParamBodyAngleRX', 'ParamBodyAngleRY', 'ParamBodyAngleRZ', 'Param138',
        'ChestX1', 'ChestY1'}
EYES = {'ParamEyeLOpen', 'ParamEyeROpen', 'EyeSmile', 'LEyeSquint', 'REyeSquint'}
FACE = {'ParamMouthForm', 'ParamMouthOpenY', 'MouthSmile_L', 'MouthSmile_R', 'JawOpen',
        'CheeckPuff', 'ParamBreath', 'Mouthpucker', 'MouthFunnel', 'MouthX',
        'MouthPressLipOpen', 'MouthPuckerWiden', 'MouthRollUpper', 'MouthRollLower',
        'TongueOut', 'NoseNeer', 'BrowInnerUp', 'ParamBrowLY', 'ParamBrowRY'}
PHYS = {'LArm', 'RArm', 'LForearm', 'RForearm', 'LHand', 'RHand',
        'ShoulderY', 'ShoulderZ', 'Param55', 'Param58'}
ARM_RANGE = [(11, 11), (27, 32), (36, 43), (55, 62)]


def is_arm(pid):
    if pid in ('Movement1', 'Movement2', 'Movement3'):
        return True
    if pid.startswith('Param'):
        try:
            n = int(pid[5:])
        except ValueError:
            return False
        return any(a <= n <= b for a, b in ARM_RANGE)
    return False


def is_expr(pid):
    return pid.startswith('key') or pid in ('LCry', 'RCry', 'SweatBurst1', 'SweatBurst2',
                                            'SweatBurst3', 'SweatBurst4', 'ShockL', 'ShockR',
                                            'Startwinkle', 'Divider22', 'Paramshuiyin7')


def group_of(pid):
    if pid in HEAD:
        return 'head'
    if pid in GAZE:
        return 'gaze'
    if pid in BODY:
        return 'body'
    if pid in EYES:
        return 'eyes'
    if pid in FACE:
        return 'face'
    if pid in PHYS:
        return 'phys'
    if is_arm(pid):
        return 'arm'
    if is_expr(pid):
        return 'expr'
    return 'other'


def parse_segments(seg):
    out = [(float(seg[0]), float(seg[1]))]
    i = 2
    while i + 1 < len(seg):
        ty = int(seg[i])
        if ty == 0:
            out.append((float(seg[i + 1]), float(seg[i + 2])))
            i += 3
        else:
            out.append((float(seg[i + 4]), float(seg[i + 5])))
            i += 7
    return out


def sample(pts, t):
    if t <= pts[0][0]:
        return pts[0][1]
    if t >= pts[-1][0]:
        return pts[-1][1]
    lo, hi = 0, len(pts) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (ta, va), (tb, vb) = pts[lo], pts[hi]
    return vb if tb == ta else va + (vb - va) * (t - ta) / (tb - ta)


def load(path):
    d = json.load(open(path, encoding='utf-8'))
    dur = float(d['Meta']['Duration'])
    curves = {c['Id']: parse_segments(c['Segments']) for c in d['Curves']}
    n = int(dur * FPS) + 1
    ts = [i / FPS for i in range(n)]
    ser = {pid: [sample(pts, t) for t in ts] for pid, pts in curves.items()}
    return dur, ts, ser


def window_changes(ts, ser, group, thresh=0.05, min_len=0.30, close_gap=0.25):
    pids = [p for p in ser if group_of(p) == group]
    if not pids:
        return []
    total = [0.0] * len(ts)
    for p in pids:
        v = ser[p]
        for i in range(1, len(v)):
            total[i] += abs(v[i] - v[i - 1])
    marks = [w > thresh for w in total]
    gap_n = int(close_gap / BIN)
    out, i = [], 0
    while i < len(marks):
        if not marks[i]:
            i += 1
            continue
        j = i
        while j < len(marks):
            if marks[j]:
                j += 1
                continue
            look = min(len(marks) - 1, j + gap_n)
            if any(marks[j:look + 1]):
                j = look
                continue
            break
        if ts[min(j, len(ts) - 1)] - ts[i] >= min_len:
            i0, i1 = i, min(j, len(ts) - 1)
            cand = []
            for p in pids:
                v = ser[p][i0:i1 + 1]
                rng = max(v) - min(v)
                if rng > 0.03:
                    cand.append((rng, p, v[0], v[-1], min(v), max(v)))
            cand.sort(reverse=True)
            out.append({
                't0': round(ts[i0], 2),
                't1': round(ts[i1], 2),
                'params': [{'id': p, 'from': round(s, 2), 'to': round(e, 2),
                            'min': round(lo, 2), 'max': round(hi, 2)}
                           for _, p, s, e, lo, hi in cand[:3]],
            })
        i = j + 1
    return out


def arm_windows(ts, ser):
    """每组的抬起/放下时间窗。"""
    out = {}
    for m in ('Movement1', 'Movement2', 'Movement3'):
        if m not in ser:
            continue
        v = ser[m]
        rise = None
        for i in range(1, len(v)):
            if v[i] > 0.5 and v[i - 1] <= 0.5:
                rise = ts[i]
                break
        fall = None
        if rise is not None:
            for i in range(1, len(v)):
                if ts[i] > rise and v[i] < 0.5 and v[i - 1] >= 0.5:
                    fall = ts[i]
                    break
        if rise is None:
            continue
        out[m[-1]] = {'rise': round(rise, 2),
                      'fall': round(fall, 2) if fall else None,
                      'hold': round((fall or ts[-1]) - rise, 2)}
    return out


def amps(ser, pids):
    out = {}
    for p in pids:
        if p in ser:
            v = ser[p]
            if max(v) - min(v) > 0.01:
                out[p] = [round(min(v), 2), round(max(v), 2)]
    return out


TIER_STEADY, TIER_COZY, TIER_BOMB = 'steady', 'cozy', 'bomb'


def tier_of(a):
    px = max(abs(x) for x in a.get('PositionX', [0, 0]))
    lean = max(abs(x) for x in a.get('LeanInput', [0, 0]))
    az = max(abs(x) for x in a.get('AngleZ', [0, 0]))
    m = max(px, lean * 0.8, az * 0.8)
    if m <= 10:
        return TIER_STEADY
    if m <= 19:
        return TIER_COZY
    return TIER_BOMB


# 语义意图 → 官方资产（body 用某一整条动作的时间窗；arm 只用三条说话原片）
MAPPING = [
    ('打招呼', TIER_COZY, '表演-04-俏皮', [0.5, 6.0], '正常说话-抚胸', '脸红', '起手轻快，1.5s 内抬手'),
    ('自我介绍', TIER_STEADY, '表演-09-沉稳', [0.5, 12.0], '正常说话-抚胸', '—', '慢节奏长保持'),
    ('讲解/说明', TIER_STEADY, '表演-10-决意', [0.5, 14.0], '正常说话-食指', '—', '配点头，每 3–4s 一拍'),
    ('思考', TIER_STEADY, '表演-01-疑惑', [0.5, 10.0], '正常说话-抚胸', '—', 'AngleX −15 侧看 + 歪头'),
    ('疑惑', TIER_STEADY, '表演-01-疑惑', [3.0, 12.0], '正常说话-食指', '—', '惊讶表情别叠 key*'),
    ('惊讶', TIER_COZY, '情绪-惊讶-1', [0.0, 3.6], '—', '—', '短脉冲，≤4s'),
    ('开心', TIER_COZY, '情绪-开心-1', [0.0, 3.6], '正常说话-抚胸', '脸红', '脉冲式，别连续 8s'),
    ('撒娇', TIER_COZY, '表演-14-撒娇', [0.5, 20.0], '正常说话-抚胸', '脸红', 'LeanInput 到 −22，手只抬一次'),
    ('撒娇加强', TIER_BOMB, '表演-15-撒娇进阶', [0.5, 20.0], '正常说话-抚胸', '脸红', 'LeanInput −26，只用于爆点'),
    ('害羞', TIER_STEADY, '情绪-害羞-1', [0.0, 8.0], '正常说话-抚胸', '脸红', 'AngleX 实测 ±27，幅度大但短'),
    ('生气', TIER_STEADY, '情绪-生气-2', [0.0, 8.0], '正常说话-食指', '—', ''),
    ('难过', TIER_STEADY, '情绪-难过-1', [0.0, 10.0], '正常说话-抚胸', '—', '几乎不动的低头'),
    ('鼓励/打气', TIER_STEADY, '表演-03-骄傲', [0.5, 10.0], '正常说话-食指', '—', 'Mv2+Mv3 组合，注意双手'),
    ('告别', TIER_STEADY, '表演-09-沉稳', [10.0, 20.0], '正常说话-抚胸', '—', '收尾回中立'),
    ('唱歌-主歌', TIER_STEADY, '表演-09-沉稳', [0.5, 28.0], '正常说话-抚胸', '脸红', '手臂 1:1 搬，换手 0'),
    ('唱歌-副歌', TIER_COZY, '表演-14-撒娇', [0.5, 20.0], '正常说话-抚胸', '爱心眼', '身段用 14 的节拍，手臂仍只一条'),
    ('唱歌-爆点', TIER_BOMB, '表演-13-造型', [2.0, 14.0], '正常说话-狗尾草', '爱心眼', '只 1 段，前后必须回 steady'),
    ('直播冷场', TIER_STEADY, '表演-05-重心', [0.0, 26.2], '正常说话-抚胸', '—', '纯重心八拍，无手臂曲线'),
]


HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DICT = os.path.join(REPO, 'dict')
EXPR_JSON = os.path.join(DICT, 'l2d-expressions.json')
# 整张脸图层替换类键：一旦激活会把嘴部动画顶掉，唱歌/说话场景禁用
DANGER_KEYS = {'key1', 'key3', 'key5', 'key6', 'key10'}


def key_labels():
    import re
    rev = {}
    try:
        d = json.load(open(EXPR_JSON, encoding='utf-8'))
    except OSError:
        return rev
    for name, e in d.items():
        for p in e.get('parameters', []):
            pid = p.get('id', '')
            if pid.startswith('key') or pid.startswith('Clothes'):
                rev.setdefault(pid, [])
                if name not in rev[pid]:
                    rev[pid].append(name)
    return rev


BODY_HEAD_ARM = None


def activity_profile(ts, ser):
    """0.5s 一格的活动度：身体+头+手臂参数的逐帧 |Δ| 之和，再按格取均值。"""
    import math
    pids = [p for p in ser if group_of(p) in ('body', 'head', 'arm')]
    total = [0.0] * len(ts)
    for p in pids:
        v = ser[p]
        for i in range(1, len(v)):
            total[i] += abs(v[i] - v[i - 1])
    step = 0.5
    nb = max(1, int(math.ceil(ts[-1] / step)))
    prof = []
    for b in range(nb):
        lo = int(b * step * FPS)
        hi = min(len(ts) - 1, int((b + 1) * step * FPS))
        seg = total[lo:hi + 1] or [0.0]
        prof.append(round(sum(seg) / len(seg), 3))
    return prof


def best_windows(prof, duration, dur, top=3):
    """在活跃度曲线上找最活跃的 dur 秒窗口（0.5s 步进）。"""
    import math
    need = max(1, int(round(dur / 0.5)))
    if need >= len(prof):
        return [{'at': 0.0, 'score': round(sum(prof) / len(prof), 2)}]
    best = []
    for i in range(0, len(prof) - need + 1):
        sc = sum(prof[i:i + need]) / need
        best.append({
            'at': round(i * 0.5, 1),
            'score': round(sc, 2),
            'fit': round(max(0.0, min(1.0, (duration - (i * 0.5 + dur)) / 1.0)), 2),
        })
    best.sort(key=lambda x: (-x['score'], -x['fit']))
    return best[:top]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lib', default=os.path.join(REPO, '.motions-lib'))
    ap.add_argument('--out', default=os.path.join(DICT, 'l2d-motion-dict.json'))
    ap.add_argument('--md', default='')
    ap.add_argument('--mapping', default='')
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.lib, '*.motion3.json')))
    motions = []
    for path in files:
        name = os.path.basename(path).replace('.motion3.json', '')
        dur, ts, ser = load(path)
        arm = amps(ser, [p for p in ser if group_of(p) == 'arm'])
        body = amps(ser, [p for p in ser if group_of(p) == 'body'])
        head = amps(ser, [p for p in ser if group_of(p) == 'head'])
        face = amps(ser, [p for p in ser if group_of(p) == 'face'])
        eyes = amps(ser, [p for p in ser if group_of(p) == 'eyes'])
        # 只有真正被动画化的曲线才算数（作者把大量参数写成恒 0 常量）
        def active(pid, th=0.25):
            v = ser.get(pid)
            return bool(v) and (max(v) - min(v)) > th

        kl = key_labels()
        keys = sorted([p for p in ser if p.startswith('key') and active(p, 0.4)])
        key_sem = ['%s=%s' % (k, '/'.join(kl.get(k, ['?'])[:2])) for k in keys]
        danger = [k for k in keys if k in DANGER_KEYS]
        mov = arm_windows(ts, ser)
        prof = activity_profile(ts, ser)
        m = {
            'name': name,
            'duration': round(dur, 2),
            'curves': len(ser),
            'tier': tier_of(body),
            'hasMouth': bool(ser.get('ParamMouthOpenY')) and (max(ser['ParamMouthOpenY']) - min(ser['ParamMouthOpenY'])) > 0.2,
            'faceSwapKeys': key_sem,
            'faceSwapDanger': danger,
            'arms': {
                'groups': sorted(mov.keys()),
                'switches': len(mov),
                'windows': mov,
            },
            'amp': {'body': body, 'head': head, 'arm': {k: v for k, v in list(arm.items())[:6]},
                    'face': face, 'eyes': eyes},
            'activity': prof,
            'bestWindows': {d: best_windows(prof, dur, d) for d in (4, 6, 10, 14, 20) if d < dur},
            'beats': {
                'body': window_changes(ts, ser, 'body'),
                'head': window_changes(ts, ser, 'head'),
                'face': window_changes(ts, ser, 'face'),
                'eyes': window_changes(ts, ser, 'eyes'),
            },
        }
        m['fits'] = {
            'sing': not danger,
            'talk': m['hasMouth'],
            'vt': True,
        }
        motions.append(m)

    dict_obj = {
        'version': 1,
        'generatedBy': 'scripts/l2d-dict.py',
        'source': 'OPFS preset-live2d-1/Animation (official 44)',
        'params': {
            'head': sorted(HEAD), 'gaze': sorted(GAZE), 'body': sorted(BODY),
            'eyes': sorted(EYES), 'face': sorted(FACE), 'physImmutable': sorted(PHYS),
        },
        'tiers': {
            TIER_STEADY: '稳态：PositionX/AngleZ ≤10，适合讲话、副歌前的铺底',
            TIER_COZY: '黏人档：PositionX ≤19 或 LeanInput ≤−20，适合主歌、撒娇',
            TIER_BOMB: '炸场档：PositionX ≥20，只适合副歌爆点，别连续用',
        },
        'mapping': [{'intent': i, 'tier': t, 'body': b, 'window': w, 'arm': a, 'face': f, 'note': n}
                    for i, t, b, w, a, f, n in MAPPING],
        'motions': motions,
    }

    json.dump(dict_obj, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('wrote', args.out, os.path.getsize(args.out), 'bytes,', len(motions), 'motions')

    if args.mapping:
        json.dump({'version': 1, 'generatedBy': 'scripts/l2d-dict.py',
                   'source': dict_obj['source'], 'tiers': dict_obj['tiers'],
                   'mapping': dict_obj['mapping']},
                  open(args.mapping, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('wrote', args.mapping, os.path.getsize(args.mapping), 'bytes')

    # ---- 瘦身版：给 agent 塞进上下文用，只留决策字段 ----
    slim = []
    for m in motions:
        def top(bs, n=3):
            out = []
            for b in bs[:n]:
                p = b['params'][0] if b['params'] else None
                out.append({'t': [b['t0'], b['t1']],
                            'p': p['id'] if p else None,
                            'v': [p['min'], p['max']] if p else None})
            return out
        slim.append({
            'name': m['name'], 'dur': m['duration'], 'tier': m['tier'],
            'arms': m['arms']['groups'], 'switches': m['arms']['switches'],
            'holds': {k: v['hold'] for k, v in m['arms']['windows'].items()},
            'body': {k: v for k, v in list(m['amp']['body'].items())[:4]},
            'head': {k: v for k, v in list(m['amp']['head'].items())[:3]},
            'mouth': m['hasMouth'], 'faceswap': m['faceSwapKeys'], 'faceswapDanger': m['faceSwapDanger'],
            'activity': m['activity'],
            'bestWindows': m['bestWindows'],
            'beats': {'body': top(m['beats']['body']), 'head': top(m['beats']['head']),
                      'face': top(m['beats']['face'], 2), 'eyes': top(m['beats']['eyes'], 2)},
        })
    slim_path = args.out.replace('.json', '.slim.json')
    json.dump({'version': 1, 'tiers': dict_obj['tiers'], 'motions': slim},
              open(slim_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('wrote', slim_path, os.path.getsize(slim_path), 'bytes')

    # ---- Markdown：人 + agent 都读 ----
    if not args.md:
        return
    L = []
    L.append('# Live2D 动作语义字典（官方 44 条）\n')
    L.append('> 由 `scripts/l2d-dict.py` 从 OPFS 现网动作库机械拆解生成，**所有数字都是原作者曲线里的实测值，不是估算**。')
    L.append('> 重新生成：`node scripts/pull-motions.mjs --out .motions-lib` 再 `python scripts/l2d-dict.py --lib .motions-lib --out dict/l2d-motion-dict.json --mapping dict/l2d-motion-mapping.json --md dict/l2d-motion-dict.md`。\n')
    L.append('## 1. 怎么用这本字典\n')
    L.append('1. 先定**情绪档**（steady / cozy / bomb），再从该档里挑 1 条动作当"身体层"；')
    L.append('2. 手臂层**不要自己拧关节**，只从 `正常说话-抚胸 / 正常说话-食指 / 正常说话-狗尾草` 三条原片里取，用 `l2d-compose.mjs` 的 `armMap` 做时间重映射；')
    L.append('3. 一条编排里换手 ≤2 次、每次保持 ≥8s；')
    L.append('4. 表情只用叠加型（`脸红/爱心眼`），任何 `key*` 换脸表情会吃掉嘴部动画，唱歌场景禁用。\n')
    L.append('## 2. 参数族\n')
    L.append('| 族 | 参数 | 是否可写 | 备注 |')
    L.append('|---|---|---|---|')
    L.append('| 头 | AngleX/Y/Z | ✅ | 头转向/点头/歪头，单位度 |')
    L.append('| 身 | PositionX/Y/Z、LeanInput、ShoulderX | ✅ | **唯一能撑大幅度的族** |')
    L.append('| 胸腔 | ParamBodyAngleX/Y/Z/RX/RY/RZ、ChestX1/Y1、Param138 | ❌ 无效 | 实测写入后画面零变化，别用 |')
    L.append('| 眼 | ParamEyeLOpen/ROpen、ParamEyeBallX/Y、EyeSmile | ✅ | |')
    L.append('| 口 | ParamMouthOpenY/Form、MouthSmile_L/R | ✅ | 唱歌时 MouthOpenY 归音频口型 |')
    L.append('| 臂 | Movement1/2/3 + Param11/27–32/36–43/55–62 | ⚠️ | 只能整体搬作者片段的窗口 |')
    L.append('| 物理输出 | LArm/RArm/LForearm/RForearm/LHand/RHand/ShoulderY/Z/Param55/Param58 | ❌ | 引擎每帧覆写 |\n')
    L.append('## 3. 幅度三档（按实测极值划分）\n')
    L.append('| 档 | 判据 | 用法 |')
    L.append('|---|---|---|')
    L.append('| steady | PositionX ≤10 且 LeanInput ≤12 | 讲话、主歌铺底 |')
    L.append('| cozy | PositionX ≤19 或 LeanInput ≤−20 | 主歌、撒娇、副歌前 |')
    L.append('| bomb | PositionX ≥20 | 只做副歌爆点，别连用 |\n')
    L.append('## 4. 动作清单\n')
    L.append('| 动作 | 时长 | 档 | 手臂组 | 换手 | 保持 | PositionX | LeanInput | AngleX | AngleZ | 嘴 | 换脸 |')
    L.append('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for m in motions:
        b = m['amp']['body']
        h = m['amp']['head']
        arms = ''.join(m['arms']['groups']) or '—'
        hold = max([v['hold'] for v in m['arms']['windows'].values()], default=0)
        L.append('| %s | %.1fs | %s | %s | %d | %.1fs | %s | %s | %s | %s | %s | %s |' % (
            m['name'], m['duration'], m['tier'], arms, m['arms']['switches'], hold,
            b.get('PositionX', '—'), b.get('LeanInput', '—'),
            h.get('AngleX', '—'), h.get('AngleZ', '—'),
            '有' if m['hasMouth'] else '—', ''.join(m['faceSwapKeys']) or '—'))
    L.append('\n## 5. 语义配方表（意图 → 资产）\n')
    L.append('| 意图 | 档 | 身体层 | 窗口 | 手臂层 | 表情 | 备注 |')
    L.append('|---|---|---|---|---|---|---|')
    for i, t, b, w, a, f, n in MAPPING:
        L.append('| %s | %s | %s | %.1f–%.1fs | %s | %s | %s |' % (i, t, b, w[0], w[1], a, f, n))
    L.append('\n## 6. 节拍表（身体层 / 头部层）\n')
    L.append('> 每格 = 一个"拍"：时间窗 + 主导参数区间。照着搬就是作者的原节奏。\n')
    for m in motions:
        if not (m['beats']['body'] or m['beats']['head']):
            continue
        L.append('### %s（%.1fs，%s）' % (m['name'], m['duration'], m['tier']))
        for g in ('body', 'head'):
            bs = m['beats'][g]
            if not bs:
                continue
            parts = []
            for b in bs[:8]:
                p = b['params'][0] if b['params'] else None
                if not p:
                    continue
                parts.append('%.1f–%.1f %s %+.1f→%+.1f' % (b['t0'], b['t1'], p['id'], p['from'], p['to']))
            L.append('- **%s**：%s' % ('身体' if g == 'body' else '头部', '；'.join(parts)))
        L.append('')
    L.append('## 7. 硬规则（违反就会翻车，都是踩过的）\n')
    L.append('1. `AngleZ` 只能有一个来源：`tilt` 与 `pose`/`sway` 混写会直接编译报错；')
    L.append('2. `PositionZ` 同理：`tilt` 自己就会写 PositionZ，别和 `pose` 里的 PositionZ 叠；')
    L.append('3. `tilt`/`nod`/`look`/`sway` 已经各自占好参数，见 §2 归属表，别越界；')
    L.append('4. 手臂曲线**整条搬**（含 Param11/27–32 手掌手指串），只搬 20 个大参数会丢手指姿态 → 抬手落手出现"多一条手臂"；')
    L.append('5. `Movement1/2/3` 是换手组开关，作者原件是 0.8s 斜坡，**禁止二值化**（二值化 = 两套绑骨半开 = 残影）；')
    L.append('6. 烘焙 `FadeInTime/FadeOutTime` 必须是 0（曲线自己带缓动，再叠引擎 fade 就是三重软化 = 起手慢）；')
    L.append('7. 微笑要打成 0.4s 的**脉冲**（官方是 0.8s/14.3s/27.9s 三次），不要整段挂着；')
    L.append('8. 头比身体**晚 0.1–0.3s** 跟随，同时动会显得假；')
    L.append('9. 单条编排 ≤64 个 action，单段 0.2–20s（expression 到 59s），总长 ≤60s；')
    L.append('10. 收尾必须回中立：最后 0.9s 内所有参数归默认，否则切回待机会"甩"。\n')
    open(args.md, 'w', encoding='utf-8').write('\n'.join(L))
    print('wrote', args.md, os.path.getsize(args.md), 'bytes')


if __name__ == '__main__':
    main()
