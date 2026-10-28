import { build } from 'esbuild';
import { build as vite } from 'vite';
await build({entryPoints:['src/main/index.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist/main/index.cjs',external:['electron','sharp']});
await build({entryPoints:['src/preload/index.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist/preload/index.cjs',external:['electron']});
await build({entryPoints:['src/workers/image.cjs'],bundle:true,platform:'node',format:'cjs',outfile:'dist/workers/image.cjs',external:['sharp']});
await vite({root:'src/renderer',base:'./',build:{outDir:'../../dist/renderer',emptyOutDir:true}});
