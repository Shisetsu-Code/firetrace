# Button Browser Implementation Plan

Plan original de la versión 1.0, completado. La versión 1.1 cambia la política de lectura y publicación según [stability-design.md](stability-design.md); ese documento define el comportamiento vigente de verify y snapshot.

Goal: navegador operable con salida verificable de botones y coordenadas.
Architecture: Node HTTP + un Chromium por servicio; observaciones inmutables y comandos secuenciales.
Tech Stack: Playwright, Sharp, Node 22+.
Spec: docs/design.md

## Tareas
- [x] Núcleo: detector DOM, snapshots/crops y control de navegador; tests de exclusiones, iframe, scroll y caducidad.
- [x] Detector Pixi: CDP bound listener → InteractionManager → scene; traversal sólo lectura, transformación de coordenadas, warnings explícitos.
- [x] Panel web: URL, screenshot, overlays, recortes, filtros y consola sobre API estable.
- [x] Adaptador visual opcional, CLI, Docker y guía español.
- [x] Pruebas en Chromium, revisión independiente, empaquetado persistente.

## Interfaz compartida
POST /api/command {command:string | object,commandId?:string} → {ok:true,result:object,observation?:Observation} o {ok:false,error:{code,message}}. GET /api/state → {ok:true,observation:Observation|null,busy:boolean,visionConfigured:boolean}. GET /artifacts/{observationId}/{file}.
Observation: {observationId,timestamp,url,title,viewport:{width,height,deviceScaleFactor},coordinateSpace,buttons:[{id,label,kind,source,confidence,actionable,bbox:{x,y,width,height},center:{x,y},normalized:{x,y,width,height},cropUrl}],screenshotUrl,annotatedUrl,contactSheetUrl,warnings:string[],timingMs}. 

Detector API: async detectEngineButtons(page,{includeDisabled=false}={}) -> {buttons:Candidate[],warnings:string[],canvasCount:number}; Candidate {label,kind,source,confidence,actionable,bbox:{x,y,width,height},targetKey:string}; optional center. Detección no ejecuta eventos de usuario. Root assigns button IDs/crops.

Comandos de texto: goto URL; detect; click ID; click X Y; move X Y; scroll DY [DX]; type TEXT; press KEY; wait MS; back; forward; reload; resize W H; tabs; newtab [URL]; switch INDEX; close; export.
Comandos JSON equivalentes con {action:"click",id:"b1",observationId:"..."} o {action:"click",x:100,y:200}; {action:"observe",vision:true}; {action:"goto",url:"https://..."}.

## Criterios de revisión
Coordenadas después de iframe/escala/scroll; botones tapados/deshabilitados; identificadores obsoletos; ninguna credencial HAR incluida; sólo bind localhost sin token, host remoto requiere token y same-origin; reconocimiento visual marcado como candidato.
