# OpenPLC - Cobot 6DOF Smart Demo

Este programa reproduce en OpenPLC el clip `Ciclo_Asistencia` usado por `Start Smart Demo` para `cobot-6dof.glb`. El ciclo dura 10 segundos, se repite y usa la misma interpolacion suave entre poses. El archivo usa el formato POU de OpenPLC Editor: primer bloque de declaraciones `VAR...END_VAR` y segundo bloque con el cuerpo ST. No incluye wrappers `PROGRAM`, `FUNCTION` ni `CONFIGURATION`.

## Carga

1. Crear un programa nuevo en OpenPLC y cargar `cobot_6dof_smart_demo.st`.
2. Compilar, iniciar el runtime y habilitar el servidor Modbus TCP.
3. En 3D Asset Forge, abrir `Digital Twin Scenario` con el cobot seleccionado.
4. Configurar `IP / host`, el puerto Modbus del runtime y `Unit ID 1`.
5. Pulsar `Auto Detect Map`. La plataforma prueba los puertos 502/5020 y Unit ID 1/0, y valida `%QW90..%QW105`.
6. Confirmar `HR start = 100` y `Data = INT16 rad x10000`.
7. Pulsar `Connect OpenPLC`. El contador `RX` debe aumentar, la linea `RAW` debe cambiar y ambos robots deben ejecutar el mismo ciclo.

## Variante de recorrido ampliado

`cobot_6dof_smart_demo_amplified.st` conserva el mismo mapa Modbus y los modos `Manual`, `Auto` y `Home`, pero ejecuta un ciclo suave de 18 segundos con mayor recorrido en J1-J6. Los extremos usados son J1 ±150 grados, J2 entre -100 y 80, J3 entre 25 y 145, J4 entre -140 y 140, J5 entre -120 y 120 y J6 entre -170 y 170.

Todos los valores permanecen dentro de la capacidad de `INT16 rad x10000` (aproximadamente ±187,7 grados). Estos rangos estan destinados a validar el modelo 3D. Antes de controlar hardware real deben sustituirse por los limites certificados del fabricante, comprobar colisiones y aplicar seguridad funcional.

## Celda IoT de mantenimiento por condicion

`cobot_6dof_iot_condition_monitoring.st` recibe telemetria real de un CC2650 montado en la muneca del robot. Conserva el formato OpenPLC Editor de dos bloques: declaraciones `VAR...END_VAR` y cuerpo ST, sin wrappers adicionales.

| Wire | Variable | Escala |
| ---: | --- | --- |
| 120 | Temperatura | grados C x100, `INT16` |
| 121 | Humedad relativa | %RH x100, `UINT16` |
| 122 | Magnitud giroscopio | grados/s x100, `UINT16` |
| 123 | Antiguedad de muestra | ms |
| 124 | Calidad | `1 valida`, `0 invalida` |

Estados de decision: `0 NORMAL`, `1 WARNING`, `2 TRIP`, `3 STALE`. En WARNING el sobre de movimiento baja al 55%; en TRIP o STALE el robot vuelve a Home y bloquea el ciclo. Los umbrales incluidos son valores de laboratorio y deben calibrarse con una baseline de la maquina real.

## Mapa

| Direccion wire | Holding Register | Variable | Formato |
| --- | --- | --- | --- |
| 90 | 40091 | Command | `0=STOP`, `1=RUN`, `2=HOME` |
| 91 | 40092 | Status | `0=STOP`, `1=RUN`, `2=HOME` |
| 92 | 40093 | ActiveStep | `0..6` |
| 93 | 40094 | ElapsedMs | Milisegundos del ciclo |
| 100..105 | 40101..40106 | J1..J6 | `INT16`, radianes x 10000 |

En OpenPLC v3, `%QW100` corresponde a la direccion wire 100 (`HR40101`). `%MW` usa otra zona que comienza en wire 1024; este programa no utiliza `%MW`. En OpenPLC Runtime v4 el inicio del buffer de Holding Registers es configurable en el driver. Si se cambia esa configuracion, el mapa debe ajustarse en la plataforma.

## Configuracion del Modbus Slave en Runtime v4

El archivo `%LOCALAPPDATA%\OpenPLC Runtime\openplc-runtime\core\src\drivers\plugins\python\modbus_slave\modbus_slave_config.json` debe usar las claves exactas `network_configuration` y `buffer_mapping`:

```json
{
  "network_configuration": { "host": "127.0.0.1", "port": 502 },
  "buffer_mapping": {
    "holding_registers": { "qw_count": 1024, "mw_count": 0, "md_count": 0, "ml_count": 0 },
    "coils": { "qx_bits": 8192, "mx_bits": 0 },
    "discrete_inputs": { "ix_bits": 8192 },
    "input_registers": { "iw_count": 1024 }
  },
  "word_order": "high_word_first"
}
```

`plugins.conf` debe tener `modbus_slave` habilitado (`...,1,0,...`). Tras editar estos archivos hay que reiniciar OpenPLC Runtime. La consola debe mostrar `Modbus slave plugin listening on 127.0.0.1:502`; que el PLC indique `RUNNING` por si solo no garantiza que el puerto Modbus haya podido enlazarse. El puerto se puede cambiar tanto en este JSON como en el campo `Port` del dashboard; ambos valores deben coincidir.
