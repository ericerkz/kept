# Roboto font files

`Roboto.woff2` and `Roboto-Italic.woff2` are the official Roboto variable fonts
from the [Roboto v3.015 release](https://github.com/googlefonts/roboto-3-classic/releases/tag/v3.015).
They retain the original family metadata, weight range (100–900), and width range
(75–100%). The files are licensed under the SIL Open Font License in `OFL.txt`.

Source archive:

- File: `Roboto_v3.015.zip`
- SHA-256: `bee3e9334ea86dd63e184598f31fb16750881c2da1a6f097a66e0f66a95b3d54`
- Inputs: `web/split/Roboto[wdth,wght].ttf` and
  `web/split/Roboto-Italic[wdth,wght].ttf`

The TTF files were converted without subsetting or renaming using FontTools
4.60.1 with Brotli support:

```python
from fontTools.ttLib import TTFont

font = TTFont(source_path)
font.flavor = "woff2"
font.save(output_path)
```
