# Submáquinas de estados en tareas paralelas

## Estado

Diseño aprobado para planificación de implementación el 1 de septiembre de 2026.

## Problema

Actualmente, una tarea paralela representa una sola ejecución de agente. El
fan-out dinámico permite decidir en runtime cuántas tareas crear, pero cada una
sigue teniendo un solo prompt, un resultado fijo y ningún grafo propio.

Las etapas posteriores, las transiciones y los ciclos solo pueden modelarse en
el workflow principal. Por ello se aplican al conjunto de tareas y no como un
proceso independiente para cada elemento materializado.

## Objetivo

Permitir que una tarea paralela, estática o dinámica, ejecute un workflow
independiente como una submáquina de estados. Cada instancia debe:

- recibir un input inmutable;
- ejecutar sus propios estados, transiciones, ciclos, políticas y recuperación;
- correr en un proceso independiente del controlador padre;
- ser evaluada al terminar por un estado envolvente perteneciente al padre;
- producir el resultado fijo `succeeded | failed` requerido por el join
  paralelo; y
- publicar un resultado durable que preserve la identidad y los artefactos del
  run hijo.

El workflow hijo conserva exactamente el contrato de un workflow normal. No
se le agregan prompts, agentes, estados terminales ni campos especiales por ser
invocado como submáquina.

## Decisiones principales

- La funcionalidad extiende las tareas de `type: parallel`; no introduce un
  segundo scheduler ni un estado `workflow_map`.
- Una tarea paralela puede contener trabajo de agente o trabajo de workflow.
  Las dos formas son mutuamente excluyentes.
- El fan-out dinámico existente, `for_each` más `task`, continúa determinando
  cuántas instancias crear.
- La misma forma de tarea basada en workflow también está disponible en el mapa
  estático `tasks`.
- Cada tarea basada en workflow crea exactamente un run hijo. El padre nunca
  repite la submáquina completa.
- El workflow hijo administra sus fallos con la lógica normal de Happy Machine:
  reintentos de estados, timeouts, ciclos, límites, cancelación y recuperación.
- Al terminar el hijo, un estado envolvente del padre ejecuta una evaluación
  integrada y traduce el resultado completo a `succeeded | failed`.
- La evaluación no acepta configuración de `agent`, `prompt` o `prompt_file`.
  Happy Machine controla el runtime interno, el prompt inicial y el contrato de
  resultado.
- Para el POC, el evaluador se lanza igual que una tarea actual: Happy Machine
  no agrega flags de sandbox, permisos, red, tools ni aprobaciones. El runtime
  hereda su configuración local y su entorno.
- El join paralelo sigue siendo all-settled y calculado por el motor.

## Registro de workflows reutilizables

Los workflows que pueden ser invocados por otros workflows se registran por
ID en `happy-machine.yaml`:

```yaml
version: 1

workflows:
  process_item:
    file: workflows/process-item.yaml
```

El `id` declarado dentro del archivo debe coincidir con la clave registrada.
La configuración no descubre archivos implícitamente dentro de `workflows/`.

Antes de crear un run, Happy Machine resuelve recursivamente todas las
referencias, valida los grafos completos y rechaza IDs duplicados, archivos que
escapan del proyecto, workflows desconocidos y dependencias circulares. El
snapshot del padre incluye todos los workflows hijos alcanzables y sus
artefactos efectivos. `resume` nunca relee YAML modificado.

El workflow principal puede seguir ejecutándose directamente por ruta. Solo un
workflow usado como hijo necesita una entrada en el registro.

## Contrato de configuración de una tarea

### Trabajo de agente existente

La forma actual conserva su sintaxis y comportamiento:

```yaml
tasks:
  tests:
    agent: qa
    prompt: Ejecuta las pruebas y reporta el resultado.
```

### Trabajo de workflow estático

Una tarea estática puede seleccionar un workflow registrado:

```yaml
states:
  process_known_items:
    type: parallel
    tasks:
      first:
        type: workflow
        workflow: process_item
        with:
          item:
            id: first
            title: Procesar el primer elemento
    outcomes:
      succeeded: continue
      failed: inspect_failures
```

### Trabajo de workflow dinámico

El template dinámico usa la misma forma:

```yaml
states:
  process_items:
    type: parallel
    for_each:
      from: plan.outputs.items
    task:
      type: workflow
      workflow: process_item
      with:
        item: $item
    max_concurrency: 4
    outcomes:
      succeeded: continue
      failed: inspect_failures
```

Una tarea de workflow:

- requiere exactamente `type: workflow`, `workflow` y `with`;
- no acepta `agent`, `prompt` ni `prompt_file`;
- no acepta `attempt_timeout`, `max_attempts` ni `retry_delay`; y
- deja que el workflow hijo resuelva sus propias políticas y que la evaluación
  integrada herede las políticas de intento efectivas del estado paralelo
  padre.

`with` es un mapa no vacío de valores JSON nombrados. En un template dinámico,
`$item` representa exclusivamente el work item materializado para esa tarea.
Happy Machine resuelve y persiste el mapa completo antes de iniciar el proceso
hijo. Los valores se agregan a una sección generada de `context.md` para todos
los estados del hijo.

`$item` no es válido fuera de `for_each`. Los literales JSON son válidos en
tareas estáticas y dinámicas. Futuras fuentes de binding deben agregarse como
referencias cerradas y validadas; v1 no incluye un lenguaje general de
expresiones.

## Modelo efectivo

La definición efectiva de trabajo se convierte en una unión discriminada:

```text
ParallelTaskWork = AgentWork | WorkflowWork

AgentWork:
  agent
  prompt
  policies de intento

WorkflowWork:
  type = workflow
  workflowId
  resolvedWith
  workflowSnapshot
  evaluatorSnapshot
```

La ausencia de `type: workflow` mantiene la interpretación actual de una tarea
de agente. No se requiere migración para definiciones existentes.

## Ciclo de vida del estado envolvente

Cada tarea basada en workflow pertenece al estado paralelo del padre y avanza
por estas fases durables:

```text
queued -> child_running -> evaluating -> succeeded | failed
```

### Materialización

Antes de cualquier lanzamiento externo, Happy Machine persiste:

- el ID de la tarea o del work item;
- el mapa `with` ya resuelto;
- la referencia al workflow hijo snapshotteado;
- el workspace asignado;
- el estado inicial `queued`; y
- una identidad reservada para el run hijo.

La cola materializada es autoritativa. Recuperación nunca vuelve a resolver
`$item`, releer el output productor ni expandir la colección.

### Ejecución del hijo

Al reclamar la tarea, el padre crea y persiste la relación:

```text
parent run + parallel state + visit + task <-> child run
```

El proceso hijo ejecuta el workflow con la semántica normal de Happy Machine.
Sus estados conservan sus propias visitas, intentos, documentos, structured
outputs, límites y eventos. El padre espera su terminación, pero no incorpora
los estados del hijo a su grafo ni decide sus transiciones.

### Evaluación integrada

Cuando el hijo termina, el wrapper del padre entra en `evaluating`. Esta fase
es un estado efectivo administrado por Happy Machine; no aparece en el archivo
del workflow hijo ni requiere configuración del autor.

El evaluador recibe un contexto inmutable con:

- el input original de la tarea;
- la definición efectiva y el objetivo del workflow hijo;
- su terminación y ruta final;
- documentos y structured outputs comprometidos;
- un resumen de estados, visitas, intentos y errores; y
- el `child_run_id` y la procedencia durable de cada artefacto.

Happy Machine selecciona el runtime interno y genera un prompt inicial que le
ordena trabajar solo con el contexto suministrado, revisar los documentos del
hijo, corregirlos cuando sea necesario, ejecutar las validaciones pertinentes
y devolver el outcome correcto. El evaluador puede publicar versiones
corregidas como nuevos documentos del wrapper; los artefactos comprometidos por
el hijo permanecen inmutables.

El resultado usa el contrato actual de una tarea paralela: exactamente
`succeeded` o `failed`, documentos y un error opcional. Happy Machine valida el
resultado y los documentos con las mismas reglas actuales antes de asentarlos.
El snapshot registra la identidad y versión efectiva del evaluador y de su
prompt inicial para que recuperación no cambie esas instrucciones.

Para este POC, Happy Machine lanza el runtime con el mismo mapeo que usa para
las tareas normales y no impone configuración adicional de sandbox, permisos,
red, tools, hooks o aprobaciones. Esas capacidades provienen de la configuración
local y del entorno del runtime. El POC acepta esta dependencia externa y no
intenta garantizar aislamiento uniforme entre instalaciones.

El evaluador no presupone que la terminación técnica del hijo ya representa el
resultado funcional requerido por la tarea paralela. Su función es adaptar el
resultado completo de cualquier workflow normal al contrato fijo del join.

## Contrato de resultado del wrapper

Después de una evaluación válida, la tarea persiste un envelope equivalente a:

```json
{
  "id": "implement-auth",
  "child_run_id": "run_child_123",
  "status": "succeeded",
  "outputs": {},
  "documents": [],
  "error": null
}
```

`outputs` indexa los structured outputs comprometidos por el hijo con
procedencia suficiente para distinguir estado, visita y nombre. `documents`
contiene referencias durables, no rutas temporales del proceso hijo.

El join expone al siguiente estado una colección de envelopes en el orden de
materialización. Una tarea fallida conserva sus outputs y documentos como
evidencia, pero no los promueve automáticamente como documentos exitosos del
padre.

El join emite:

- `succeeded` cuando todos los wrappers terminaron en `succeeded`, incluida una
  colección vacía; o
- `failed` cuando uno o más wrappers terminaron en `failed`.

## Reintentos y fallos

El wrapper crea exactamente un run hijo y nunca vuelve a ejecutar ese workflow
completo. No admite políticas de intento propias.

El workflow hijo maneja sus fallos con sus políticas normales. Agotar los
intentos de uno de sus estados, alcanzar un terminal negativo o completar una
ruta alternativa forma parte del resultado durable que recibe el evaluador.

Un fallo técnico confirmado del evaluador aplica `attempt_timeout`,
`max_attempts` y `retry_delay` efectivos del estado paralelo padre, pero
reintenta solo la evaluación contra el mismo snapshot del hijo. Nunca crea un
nuevo `child_run_id`. Una decisión semántica `failed` no se reintenta.

Si una ejecución externa queda irreconciliablemente incierta, el snapshot del
hijo está corrupto o el motor no puede persistir la relación padre-hijo, el run
padre termina con fallo de motor. Happy Machine no fabrica un `failed`
semántico para ocultar incertidumbre de infraestructura.

## Concurrencia y workspaces

Un wrapper ocupa un slot de `max_concurrency` desde `child_running` hasta que
su evaluación se asienta. Al finalizar libera el slot para la siguiente tarea.
El paralelo del padre continúa usando su cola acotada y su join all-settled.

La concurrencia interna de cada hijo se rige por la definición de ese workflow.
El límite del padre controla cuántas submáquinas completas están activas, no el
número total de agentes internos que pueden ejecutar.

En modo `direct`, el hijo usa el workspace asignado actualmente a la tarea. En
modo `worktree`, el wrapper recibe un worktree de tarea y ese directorio actúa
como workspace principal del run hijo. Sus estados secuenciales lo comparten y
sus paralelos internos aplican el aislamiento normal desde ese punto. No se
introduce merge automático.

## Recuperación y cancelación

Recuperación trata la relación durable padre-hijo como autoritativa:

- tarea materializada sin hijo iniciado: inicia el hijo reservado;
- hijo activo: se reconecta al mismo `child_run_id`;
- hijo terminado sin evaluación: evalúa el resultado persistido;
- evaluación activa: reconcilia esa ejecución sin repetir el hijo;
- evaluación asentada sin join: reconstruye el join desde los wrappers; y
- join comprometido: nunca vuelve a evaluar ni transicionar.

Cancelar el padre solicita la cancelación de cada hijo activo, concilia sus
procesos y evaluaciones, marca las tareas en cola sin lanzarlas y conserva todos
los enlaces y artefactos para auditoría.

## Observabilidad

El historial del padre registra como mínimo:

- `child_run_reserved`;
- `child_run_started`;
- `child_run_settled`;
- `workflow_task_evaluation_started`;
- `workflow_task_evaluation_settled`; y
- los eventos normales de tarea y join.

`status` muestra por wrapper el `child_run_id` y su fase actual. El detalle de
estados, visitas e intentos permanece en el historial del hijo; el padre expone
un enlace y un resumen, sin duplicar toda la historia.

## Validación

La carga de definiciones debe rechazar:

- tareas que mezclan las formas `agent` y `workflow`;
- una tarea `type: workflow` con `agent`, `prompt` o `prompt_file`;
- workflows o archivos no registrados;
- una discrepancia entre el ID registrado y el ID del archivo;
- dependencias circulares entre workflows;
- `with` ausente, vacío o no serializable;
- `$item` fuera de un template `for_each`;
- políticas de reintento en el wrapper; y
- cualquier campo desconocido del contrato cerrado.

La validación recursiva ocurre antes de asignar un run ID o crear estado
durable.

## Compatibilidad

El cambio es aditivo para `version: 1`:

- las tareas de agente existentes mantienen su sintaxis y semántica;
- los paralelos estáticos y dinámicos existentes conservan scheduling, retries
  y join;
- los workflows que nunca son referenciados como hijos no necesitan registro;
- los snapshots durables existentes cargan sin adquirir comportamiento nuevo;
  y
- los cambios posteriores en archivos registrados solo afectan runs nuevos.

## Estrategia de pruebas

### Definición y snapshots

- Aceptar tareas estáticas y dinámicas basadas en workflow.
- Aceptar una mezcla de tareas de agente y workflow en un paralelo estático.
- Rechazar formas mixtas, referencias desconocidas, ciclos, bindings inválidos
  y políticas no permitidas.
- Snapshottear recursivamente hijos, evaluador integrado y artefactos.
- Conservar compatibilidad con todas las definiciones actuales.

### Ejecución

- Materializar cero, una y varias submáquinas en orden.
- Respetar `max_concurrency` durante ejecución y evaluación.
- Ejecutar ciclos, reintentos y paralelos internos del hijo.
- Verificar que cada hijo recibe solo su `with` inmutable.
- Producir evaluaciones `succeeded` y `failed` sin modificar al hijo.
- Confirmar que el evaluador usa el comando normal del runtime sin flags nuevos
  de sandbox, permisos, red, tools o aprobaciones.
- Permitir que el evaluador publique documentos corregidos sin mutar los
  artefactos comprometidos por el hijo.
- Preservar `child_run_id`, outputs, documentos, errores y procedencia.
- Confirmar que ningún fallo semántico vuelve a ejecutar el workflow hijo.

### Recuperación y cancelación

- Recuperar en cada frontera durable sin duplicar runs ni evaluaciones.
- Reintentar solo una evaluación técnicamente fallida.
- Cancelar tareas en cola, hijos activos y evaluaciones activas.
- Fallar de forma segura ante ejecución incierta o artefactos corruptos.

### Regresión

- Ejecutar las suites existentes de estados normales, paralelos estáticos,
  fan-out dinámico, cycles, retries, timeouts, recovery, cancellation,
  observability y worktree isolation.

## Criterios de aceptación

La capacidad está completa cuando un estado paralelo puede materializar cero o
más tareas basadas en workflows registrados, ejecutar cada workflow como un run
hijo independiente con input y recuperación propios, evaluarlo mediante un
estado envolvente del padre controlado por Happy Machine, producir exactamente
`succeeded | failed` por tarea y realizar el join existente sin duplicar hijos,
perder procedencia ni cambiar el comportamiento de definiciones previas.
