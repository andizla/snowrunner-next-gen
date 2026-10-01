# Third party notices

SnowRunner Next Gen is licensed under the GNU General Public License version 3 (LICENSE). It contains or builds on the
following third-party work.

## XeGTAO

The horizon search and the visibility integral of the GTAO shader follow the structure of XeGTAO (https://github.com/GameTechDev/XeGTAO), which implements "Practical Real-Time Strategies for Accurate Indirect Occlusion" by Jorge Jimenez, Xian-Chun Wu, Angelo Pesce and Adrian Jarabo. XeGTAO is distributed under the MIT License:

Copyright (C) 2016-2021, Intel Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

(The GTAO shader of the ambient occlusion modules follows that structure; it is compiled into
engine\replacements\ssao_builds and engine\replacements\gi.)

## Interleaved gradient noise

The noise function is from Jorge Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare" (SIGGRAPH 2014).

## AMD FidelityFX SSSR

The ray march of the reflection pass in engine\hid.dll (SnowRunner Shadows) is adapted from AMD's ffx_sssr.hlsli
(FidelityFX Stochastic Screen Space Reflections: the initial advance, the advance and the hierarchical ray march).

Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Bend Studio screen-space shadows

The contact shadows in engine\hid.dll (SnowRunner Shadows) are a modified copy of Bend Studio's screen-space shadows
(bend_sss_gpu.h and bend_sss_cpu.h). The changes are the port to Direct3D 11, a dispatch list built on the GPU,
depth-relative thresholds, and the composite into the game's lighting.

Copyright 2023 Sony Interactive Entertainment.

Licensed under the Apache License, Version 2.0. The licence text is in licenses\Apache-2.0.txt.

## Published methods used

- Sampling of visible normals in the reflection pass: Eric Heitz, "Sampling the GGX Distribution of Visible Normals",
  Journal of Computer Graphics Techniques 7(4), 2018 (the published listing).
- References: Uludag, "Hi-Z Screen-Space Cone-Traced Reflections" (GPU Pro 5, 2014); Salvi, "An Excursion in Temporal
  Supersampling" (GDC 2016, variance clipping); Barre-Brisebois and Bouchard, "Approximating Translucency for a Fast,
  Cheap and Convincing Subsurface Scattering Look" (GDC 2011, the sun glow through waves); the Henyey-Greenstein
  phase function (fog, smoke).
- The rebuilt shadow edges (Shadow edges, written fresh from the papers): Macedo and Apolinário, "Revectorization-Based
  Shadow Mapping" (Graphics Interface 2016); Bondarev, "Shadow Map Silhouette Revectorization" (I3D 2014).

## Game-derived content

- engine\replacements\particles: the game's own particle textures, upscaled to twice their size by the author with
  NVIDIA DLSS 5 Visual Enhancer. They remain Saber Interactive's assets and are shipped only for use with the game.
- engine\replacements\tonemap_builds: compiled from the author's reconstruction of the game's own tonemap shader.

## Node.js

engine\node.exe is Node.js, which runs the installer's engine. Node.js is licensed under the MIT licence:

Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Node.js bundles further components under their own licences; the complete text is in licenses\Node.js-LICENSE.txt.
