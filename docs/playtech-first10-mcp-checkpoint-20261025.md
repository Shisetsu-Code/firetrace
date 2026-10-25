# Playtech 10 demos — manual MCP exploration checkpoint (2026-10-25)

Mode: ChatGPT directly controlled the GitHub-hosted Chromium through the connected
Firetrace MCP and inspected screenshots after actions. Currency FUN / offline
demos, not money. This is **partial**, not exhaustive. Do not resume a possibly
pending spin without checking a fresh screenshot and balance.

| # | Game ID | Verified interactions | Special/bonus status |
| --- | --- | --- | --- |
| 1 | ashadv | Info/paytable; 2 base spins (€0.20) | Mad Hatter Tea Party requires scatter; progressive jackpot NOT ACTIVE |
| 2 | ftsis | 2 base spins (€0.25), second after Turbo ON | Scatter bonus not entered; Power banners Not available |
| 3 | gpas_aogggriffin_pop | intro cleared; 2 base spins (€5), Turbo ON for second | Free Games not triggered; Power banners Not available |
| 4 | aogmt | intro cleared; 2 base spins (€0.40), Turbo ON for second | Fortune Wheel needs scatters; Power banners Not available |
| 5 | aogroo | intro cleared; 2 base spins (€0.25), Turbo ON for second | free games not triggered; Power banners Not available |
| 6 | gpas_gstorm2_pop | intro cleared; 2 base spins (€5), first showed win €13, second showed €5 | feature not triggered; Power banners Not available |
| 7 | gpas_agstorm3_pop | intro cleared; 2 base spins (€0.50), each screenshot displayed €0.10 win | coin feature not triggered; Power banners Not available |
| 8 | gpas_mgaogkol_pop | intro cleared; Bet Options inspected (€5); 2 base spins (€5) | feature not triggered; Power banners Not available |
| 9 | gpas_aogww_pop | opened multiple times, including direct gpasclient URL | loading screen remained static; zero spins verified |
| 10 | gpas_aogwfot_pop | Double Chance ON spin €10 with €5 win (previous pass); OFF normal spin €5; ON special spin €10 with €80 win, return balance €10065 | ON/OFF wager modifier confirmed; 3/4/5-in-a-row free game wheels not triggered; Power banners Not available |

## Precise limitations

No Bonus Buy transaction was confirmed in this batch. Where the game says
"Not available" on Super/Extra/Ultimate Power, it is not a buy action.
Some games feature random free spins/bonus triggers requiring scatters;
two base spins do not verify them. The single observed accessible alternate
wager flow is Double Chance ON/OFF in Wheels of Olympus. Two spin types were
tested there, including a repeated ON test.

This run used live screenshots and returned MCP click command results, but not
a per-spin correlated HAR from the direct MCP bridge. The earlier batch
`audit-first10-001` recorded loading HTTP/WS evidence, not these interactions.

Next processing must start from **freshly inspected game state**; do not
claim full bonus coverage or replay uncertain commands.

## Reintento remoto posterior

La sesión anterior caducó al límite duro de 6900 segundos del workflow (GitHub Actions terminó con exit code 124). Se inició el nuevo workflow `40207205594` y se verificó `connected=true` en el MCP. Se reabrió Wonder Warriors (`gpas_aogww_pop`): permaneció en la misma pantalla de carga estática después de varias comprobaciones separadas y más de 40 segundos. No hubo pantalla de controles ni giros verificables. Las opciones Bonus Buy/Power de los demás juegos observadas como `Not available` no se deben marcar como compras ejecutadas. La cobertura de bonus sigue parcial.

## Reanudación 2026-10-25, runner 40207205594

Conexión MCP verificada. El juego #9 Wonder Warriors avanzó por fin desde la pantalla de carga: se observó el botón START, se pulsó y apareció la pantalla base. Se ejecutaron dos tiradas FUN de €5 cada una. La primera terminó con BIG WIN €80 y saldo €10.075 (desde €10.000, tras apuesta €5). La segunda terminó en saldo €10.070, sin bonus activado. Los cuatro botones Power superiores seguían mostrando Not available. No se observó opción de compra directa ni activación de free games en estas dos tiradas. El juego #9 ya no debe marcarse como bloqueado en carga; *sí* mantiene bonus especiales pendientes de verificar.
