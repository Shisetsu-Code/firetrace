# Conexiones y consumo de Firetrace

## Qué permanece conectado

- Firetrace PC → control Cloudflare: un WebSocket persistente por agente. Abrir
  varias ventanas reutiliza ese socket; no crea una conexión Cloudflare por ventana.
  Reconecta con espera progresiva ante cortes de red o despliegues.
- ChatGPT → MCP: Streamable HTTP. Las peticiones de herramientas siguen siendo
  invocaciones, aunque el transporte reutilice conexiones TCP/TLS.
- MCP → control: Service Binding, sin petición adicional facturable en Workers
  Standard; sí se contabiliza el CPU utilizado y los servicios asociados.

Mantener un socket abierto no convierte todas las operaciones en gratuitas.
Durable Objects factura mensajes entrantes y actividad; D1, KV y R2 tienen sus
propias operaciones y almacenamiento. No se ha consultado una factura ni el plan
de esta cuenta, por lo que no se promete una cifra monetaria de ahorro.

## Optimización

El control usa `acceptWebSocket`, compatible con hibernación, y auto-responde a
`firetrace:ping` con `firetrace:pong` mediante `setWebSocketAutoResponse`.
El agente negocia esta capacidad al conectar y envía ese latido cada 30 segundos.
No se ejecuta JavaScript del objeto ni se escribe en D1 para responder al latido.
Se mantienen los pings del protocolo WebSocket para detectar conexiones rotas.

El estado del navegador solo se transmite si cambió o al reconectar. Se comprueba
localmente cada 30 segundos y después de órdenes. Por ello, cerrar manualmente una
ventana puede tardar hasta 30 segundos en reflejarse en el estado almacenado;
`browser_list` consulta el agente en el momento. La presencia se calcula con el
socket y el timestamp del auto-pong, no mediante escrituras periódicas en D1.

| Actividad | Antes | Optimizado |
| --- | --- | --- |
| Mensajes periódicos de aplicación | 2 cada 10 s | 1 ping cada 30 s |
| Escrituras SQL en reposo estable | 6 sentencias cada 10 s | 0 por latido |
| Consultas de una orden de 25 s | aproximadamente 250 | como máximo unas 17 |
| Estado idéntico tras órdenes | se retransmitía | se omite |

Con 24 horas de reposo continuo, el código anterior podía emitir 17.280 mensajes
y ejecutar 51.840 sentencias de escritura por agente y día, antes de contabilizar
índices. Estas cifras son cálculos del código anterior, no importes de factura.
Cambios de estado, órdenes, conexión/desconexión y capturas continúan generando
operaciones. La espera progresiva de resultados comienza en 100 ms y llega a 2 s;
puede añadir hasta unos 2 s de demora al devolver el resultado de una orden larga.

Las capturas se producen solo cuando se solicitan; no hay streaming de vídeo.
No se han borrado registros ni capturas existentes ni modificado su retención.
Los navegadores corren en el PC: su CPU y memoria aumentan con las ventanas abiertas.

## Compatibilidad y despliegue

El control mantiene compatibilidad con agentes anteriores. Los agentes nuevos
detectan si existe auto-respuesta; con servidores viejos usan un latido normal
cada 30 segundos. Para obtener el ahorro completo deben actualizarse tanto el
control como el ejecutable. Reiniciar el agente cierra sus ventanas: guardar el
trabajo antes de sustituir el ejecutable.

## Fuentes de facturación

- [Workers: WebSockets y Service Bindings](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects: mensajes, duración e hibernación](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Auto-respuesta sin despertar el objeto](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse)
