# fonts/

字幕用的字体放在这里，`scripts/add-lyrics.mjs` 会把它当 `fontsdir` 传给 ffmpeg（不需要装进系统）。

默认字体：**霞鹜文楷 LXGW WenKai**（SIL OFL 1.1，中日双语共用一个字体，笔画软、适合歌词字幕）。

字体文件不入库（单个 25MB），首次使用执行：

```bash
node scripts/get-fonts.mjs            # 下载 LXGWWenKai-Medium.ttf 到这里
node scripts/get-fonts.mjs --all      # 顺带下 Light / Regular
```

换字体：`--font "字体族名" --fontsdir <目录>`，族名可用
`D:/AI/RVCover/py311/python.exe -c "from PIL import ImageFont;print(ImageFont.truetype('x.ttf',40).getname())"` 查。
