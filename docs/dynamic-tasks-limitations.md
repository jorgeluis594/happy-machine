# Limitaciones de las tareas dinámicas

Actualmente, cada tarea dinámica representa una sola ejecución. Una tarea no puede contener varios estados, definir transiciones propias ni ejecutar ciclos controlados por la máquina.

Las etapas posteriores y los ciclos solo pueden modelarse en el flujo principal. Por ello, se aplican al conjunto de tareas y no como un proceso independiente para cada una.

## Capacidad requerida

Para que cada tarea pueda recorrer varios estados o repetir etapas, se necesita soportar submáquinas de estados.

Cada tarea debería poder iniciar su propia submáquina, avanzar de manera independiente por sus estados y transiciones, ejecutar ciclos dentro de límites definidos y producir un resultado final para reunirse nuevamente con el flujo principal.
