# Arquitectura para submáquinas en tareas paralelas

## Estado

Diseño arquitectónico aprobado el 1 de septiembre de 2026.

## Propósito

Este documento traduce la especificación funcional
[`dynamic-tasks-limitations.md`](./dynamic-tasks-limitations.md) a cambios
concretos de arquitectura y código. La especificación funcional sigue siendo
la fuente autoritativa para el contrato YAML, el comportamiento observable y
los criterios de aceptación. Este documento define cómo incorporar ese
comportamiento respetando las capas y dependencias obligatorias de
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

La capacidad permite que una tarea de un estado `parallel`, estática o
materializada mediante `for_each`, ejecute un workflow registrado como un run
hijo independiente. El padre conserva su scheduler acotado y su join
all-settled. Un wrapper durable supervisa cada hijo y adapta su resultado al
contrato fijo `succeeded | failed` mediante una evaluación controlada por Happy
Machine.

## Alcance

El cambio incluye:

- registro y resolución recursiva de workflows reutilizables;
- una unión discriminada entre trabajo de agente y trabajo de workflow;
- bindings JSON inmutables mediante `with` y `$item`;
- creación idempotente y ejecución en otro proceso de un run hijo por wrapper;
- evaluación durable del resultado completo del hijo;
- recuperación, cancelación y observabilidad de la relación padre-hijo;
- compatibilidad con paralelos estáticos, fan-out dinámico, concurrencia y join
  existentes; y
- pruebas unitarias, de integración, recuperación y regresión.

Quedan fuera del POC:

- crear o modificar estados del grafo en runtime;
- un scheduler diferente para submáquinas;
- reintentar el workflow hijo completo desde el wrapper;
- un lenguaje general de expresiones para `with`;
- límites globales de agentes sumando todos los runs hijos;
- worktrees prestados o anidados administrados por el padre;
- configuración YAML del evaluador; y
- normalizar sandbox, permisos, red, tools o aprobaciones entre instalaciones.

## Restricciones heredadas

La implementación debe preservar estas decisiones ya vigentes:

- `max_items`, con valor efectivo predeterminado de `100`, pertenece al output
  productor `work_items` y limita la cardinalidad total.
- `max_concurrency` pertenece al estado consumidor y limita cuántos wrappers
  están activos; no introduce batches ni segmentos.
- La materialización completa se compromete antes de cualquier lanzamiento
  externo y es autoritativa durante recuperación.
- El grafo snapshotteado y sus transiciones no cambian según la cantidad de
  items.
- Cada coordenada del wrapper crea como máximo un run hijo.
- El workflow hijo conserva el mismo contrato de un workflow normal.
- El join del padre se calcula solamente desde los estados terminales de sus
  wrappers.

## Casos de uso

### CU-01: validar y snapshottear workflows registrados

**Actor:** comando que inicia un workflow.

**Precondición:** existe `happy-machine.yaml` y el workflow principal es
legible.

**Flujo:**

1. El adaptador de definiciones lee el registro `workflows` del proyecto.
2. Resuelve cada tarea `type: workflow` por ID.
3. Carga recursivamente los workflows alcanzables y sus artefactos efectivos.
4. Valida IDs, rutas, contratos cerrados, bindings y ciclos entre workflows.
5. Genera una definición efectiva autocontenida y un snapshot recursivo.

**Resultado:** la ejecución comienza con un grafo de dependencias completo e
inmutable.

**Fallos:** cualquier referencia, ruta, ciclo o binding inválido produce
`DefinitionError` antes de asignar un run ID.

### CU-02: ejecutar una tarea estática basada en workflow

**Actor:** scheduler de un estado paralelo.

**Precondición:** una entrada de `tasks` contiene `type: workflow`, `workflow`
y un mapa `with` válido.

**Flujo:**

1. El estado materializa el wrapper y sus bindings resueltos.
2. Reserva un `child_run_id` estable para la coordenada del wrapper.
3. Persiste la reserva antes de crear o lanzar procesos.
4. Obtiene o crea idempotentemente el run hijo con la definición snapshotteada.
5. Inicia un proceso controlador independiente para ese mismo run.
6. Espera o reconcilia su terminación y continúa con la evaluación.

**Resultado:** existe exactamente un run hijo enlazado al wrapper.

### CU-03: materializar tareas dinámicas basadas en workflow

**Actor:** scheduler al entrar a un estado `parallel` con `for_each`.

**Precondición:** existe un output `work_items` comprometido y verificable.

**Flujo:**

1. Se resuelve el output más reciente del productor que precede a la visita.
2. Se conserva el orden de la colección y el ID estable de cada item.
3. Por cada item se resuelve `with`; `$item` solo puede representar el item
   completo de ese wrapper.
4. Se persisten todos los wrappers, bindings, referencias de snapshot e
   identidades reservadas.
5. Después del commit, el worker pool inicia como máximo
   `max_concurrency` submáquinas.

**Resultado:** la recuperación reutiliza la cola materializada sin releer ni
expandir el output productor.

**Caso vacío:** cero items produce un join inmediato `succeeded` sin crear
procesos hijos.

### CU-04: evaluar un run hijo terminado

**Actor:** evaluador integrado del wrapper.

**Precondición:** el hijo está en estado terminal y su snapshot puede
verificarse.

**Flujo:**

1. El wrapper cambia durablemente a `evaluating`.
2. Se construye un contexto inmutable con bindings, definición efectiva,
   terminación, ruta, documentos, outputs, intentos, errores y procedencia.
3. Se crea un `AttemptRecord` en `launching` antes de invocar el runtime.
4. `TaskExecutor` ejecuta el evaluador con prompt, runtime y política interna
   snapshotteados.
5. Se valida el resultado `succeeded | failed` y se stagean sus documentos.
6. Un único commit asienta intento, documentos, envelope, fase terminal y
   eventos.

**Resultado:** el wrapper produce el contrato requerido por el join sin
modificar el run hijo.

### CU-05: completar el join paralelo

**Actor:** motor del workflow padre.

**Precondición:** todos los wrappers están en una fase terminal.

**Flujo:**

1. Los envelopes se ordenan según la materialización original.
2. Los artefactos exitosos se promueven con procedencia; la evidencia de
   fallos se conserva sin promoverla como documento exitoso.
3. `calculateParallelOutcome` determina el outcome.
4. El motor compromete el join y la transición normal del estado.

**Resultado:** `succeeded` si todos los wrappers tuvieron éxito; `failed` si
uno o más fallaron.

### CU-06: recuperar el padre después de un crash

**Actor:** comando `resume`.

**Precondición:** existe un run padre no terminal y un snapshot íntegro.

**Flujo:**

1. Se adquiere el lease del controlador padre.
2. Se inspecciona la fase durable de cada wrapper.
3. Se crea, inicia, recupera o reconcilia exactamente el `child_run_id`
   reservado.
4. Si el hijo ya terminó, se recupera o inicia exclusivamente su evaluación.
5. Si la evaluación ya se asentó, no se repite.
6. Cuando todos los wrappers terminan, se reconstruye el join desde sus
   registros persistidos.

**Resultado:** no se duplican runs hijos, procesos controladores ni intentos
activos del evaluador.

### CU-07: cancelar un padre con submáquinas activas

**Actor:** comando `cancel`.

**Flujo:**

1. El padre pasa a `canceling` bajo un fencing token válido.
2. Los wrappers en cola se cancelan sin crear hijos.
3. Se solicita cancelación de cada run hijo activo mediante el nuevo puerto.
4. Se cancelan y reconcilian los intentos activos del evaluador mediante
   `TaskExecutor`.
5. Se registran observaciones hasta confirmar detención o declarar ejecución
   incierta.
6. Se conservan enlaces, snapshots y artefactos para auditoría.

**Resultado:** el padre solo llega a `canceled` después de conciliar todo el
trabajo externo conocido.

### CU-08: consultar estado e historial

**Actor:** comandos `status` e `history`.

**Resultado:** cada wrapper muestra su fase, `child_run_id`, outcome, error y
referencia al run hijo. El detalle interno del workflow permanece en el
historial del hijo y no se duplica en el padre.

## Arquitectura objetivo

```text
CLI execute/resume/cancel/status
              │
              ▼
       Application use cases
              │
       ┌──────┴─────────┐
       ▼                ▼
WorkflowTaskCoordinator  WorkflowTaskEvaluator
       │                │
       ▼                ▼
WorkflowController     TaskExecutor
       │                │
       ▼                ▼
proceso Happy Machine  runtime de agente
       │
       ▼
     run hijo

Application ──▶ RunRepository ◀── FilesystemRunRepository
Application ──▶ ProjectDefinitions ◀── FilesystemProjectDefinitions
```

La aplicación decide cuándo reservar, crear, lanzar, esperar, evaluar y
asentar. El dominio decide qué transiciones y resultados son válidos. Los
puertos expresan efectos externos. Los adaptadores de filesystem y proceso
implementan esos efectos sin filtrar tipos tecnológicos hacia las capas
internas.

### Decisión: un puerto separado para controladores de workflow

`TaskExecutor` representa la ejecución de un agente y trabaja con prompts,
outcomes y documentos. Un run hijo, en cambio, tiene lease, grafo, visitas,
deadline, cancelación y recuperación propios. Reutilizar `TaskExecutor` para
ambos conceptos produciría un contrato ambiguo y mezclaría identidades de
intento con identidades de run.

Se agrega `WorkflowController`, un puerto dedicado a procesos que controlan
runs hijos. Su contrato tecnológico-independiente debe cubrir:

```ts
interface WorkflowController {
  start(request: ChildControllerLaunch): Promise<ChildControllerExecution>;
  recover(request: ChildControllerRecovery): Promise<ChildControllerObservation>;
  cancel(request: ChildControllerCancellation): Promise<void>;
  reconcile(request: ChildControllerReconciliation): Promise<ExternalExecutionStatus>;
}
```

`start` no crea otro run: recibe un `child_run_id` ya persistido y arranca el
controlador normal sobre ese run. `recover` y `reconcile` usan una identidad
externa estable. El adaptador inicial puede lanzar el mismo ejecutable de Happy
Machine con la operación interna equivalente a `resume`.

### Decisión: coordinación compartida, no un segundo scheduler

`WorkflowTaskCoordinator` es un servicio de aplicación usado por
`ExecuteWorkflow` y `RecoverWorkflow`. Opera un wrapper individual y devuelve
un resultado terminal o un fallo de motor. El worker pool actual continúa
seleccionando wrappers en orden y aplicando `max_concurrency`.

El servicio no recorre el grafo del hijo. Solo coordina:

- reserva y creación idempotente;
- lanzamiento o reconciliación de su proceso controlador;
- observación del estado terminal del hijo;
- transición durable a evaluación; y
- delegación en `WorkflowTaskEvaluator`.

`CancelWorkflow` utiliza las mismas identidades persistidas, pero llama
directamente a las operaciones de cancelación y reconciliación apropiadas.

## Modelo de dominio

### Definición efectiva de trabajo

El modelo de definiciones reemplaza la suposición de que toda tarea paralela
es trabajo de agente:

```ts
type ParallelTaskWorkDefinition =
  | { type: "agent"; work: AgentWorkDefinition }
  | {
      type: "workflow";
      workflowId: string;
      with: Record<string, JsonBindingDefinition>;
      workflow: EffectiveExecutionDefinition;
      evaluator: EvaluatorDefinition;
    };
```

La forma de agente existente se normaliza internamente a `type: "agent"`,
aunque el YAML no requiera ese discriminante. La forma de workflow siempre lo
requiere. Las variantes estática y dinámica del estado paralelo continúan
determinando de dónde provienen el ID y los bindings.

### Registro durable del wrapper

`ParallelTaskRecord` incorpora un discriminante de ejecución. La rama de
workflow contiene, como mínimo:

```ts
interface WorkflowTaskExecutionRecord {
  type: "workflow";
  phase: "queued" | "child_running" | "evaluating" | "succeeded" | "failed";
  coordinate: {
    parentRunId: string;
    stateId: string;
    visitNumber: number;
    taskId: string;
  };
  childRunId: string;
  resolvedWith: Record<string, JsonValue>;
  childController?: ChildControllerExecutionRecord;
  evaluationAttempts: AttemptRecord[];
  result?: WorkflowTaskEnvelope;
}
```

La coordenada es única dentro del run padre y determina una única identidad
reservada. `resolvedWith` se persiste antes del hijo y nunca se recalcula. El
registro del controlador externo se adjunta después de que `start` confirma el
lanzamiento.

El run hijo incorpora procedencia inversa:

```ts
interface ParentRunReference {
  runId: string;
  stateId: string;
  visitNumber: number;
  taskId: string;
}
```

La referencia permite auditoría y validación de consistencia, pero el hijo no
lee ni modifica el estado del padre.

### Invariantes

Las funciones puras de dominio deben impedir:

- cambiar `child_run_id` después de reservarlo;
- saltar de `queued` directamente a evaluación;
- volver a una fase no terminal después de asentar un envelope;
- calcular el join mientras exista un wrapper no terminal;
- adjuntar un run hijo cuya procedencia no coincida con la coordenada;
- crear más de un hijo o más de una evaluación activa por identidad; y
- promover artefactos del hijo sin procedencia durable.

La política fija del evaluador se expresa como una política efectiva interna:

```text
attempt_timeout = 30 minutos
max_attempts    = 3
retry_delay     = 5 segundos
```

Esta política forma parte del snapshot y no del YAML autoral.

## Carga de definiciones y snapshots

### Registro de proyecto

`FilesystemProjectDefinitions` acepta `workflows` como nueva clave cerrada de
`happy-machine.yaml`. Cada entrada asigna un ID a un archivo. La carga debe:

1. resolver la ruta mediante las mismas defensas de `safeExistingFile`;
2. comprobar que permanece dentro del proyecto;
3. validar que el `id` del archivo coincide con la clave del registro;
4. rechazar IDs y rutas duplicados;
5. resolver referencias con DFS y detectar ciclos mediante estados
   `unvisited`, `visiting` y `visited`; y
6. producir cada definición efectiva una sola vez por carga.

Solo se incluyen en el snapshot del padre los workflows alcanzables desde sus
tareas, incluyendo dependencias transitivas. Un workflow principal ejecutado
por ruta no necesita registrarse si ningún otro workflow lo referencia.

### Artefactos

`DefinitionArtifactKind` mantiene `workflow`, pero `logicalId` deja de ser el
valor fijo `workflow`: identifica `workflow:<id>`. El manifest registra el ID,
la ruta interna, el hash y la relación de dependencia. Prompts, instrucciones
de agentes y archivos referenciados por cada hijo también se incorporan.

La definición efectiva del padre contiene las definiciones hijas necesarias
para crear runs sin releer archivos del proyecto. `resume` usa exclusivamente
el manifest persistido.

### Bindings

El parser acepta valores JSON literales y la referencia cerrada `$item`. La
validación requiere:

- `with` presente, no vacío y serializable;
- `$item` únicamente dentro del template de un `for_each`;
- ausencia de claves o referencias desconocidas; y
- exclusión mutua entre campos de agente y campos de workflow.

La resolución ocurre durante materialización. El mapa resultante se almacena
en el wrapper y se incorpora como una sección generada de `context.md` para
todos los estados del hijo.

## Persistencia e idempotencia

`RunRepository` se amplía con estas operaciones de intención específica:

```ts
reserveChildRun(request): Promise<ReservedChildRun>;
getOrCreateChildRun(request): Promise<RunRecord>;
loadChildRun(projectRoot, childRunId): Promise<RecoveredRun>;
stageWorkflowTaskEvaluationContext(request): Promise<EvaluationContextRecord>;
commitWorkflowTaskResult(request): Promise<RunRecord>;
```

`reserveChildRun` se ejecuta bajo el lease y fencing token del padre. Repetirla
con la misma coordenada devuelve la misma identidad. Una reserva con datos
incompatibles falla como corrupción o conflicto de persistencia.

`getOrCreateChildRun` publica el snapshot y `run.json` del hijo de manera
idempotente. Si el directorio ya existe, valida identidad, snapshot y
procedencia antes de devolverlo. No reemplaza contenido existente.

`commitWorkflowTaskResult` asienta atómicamente:

- el intento válido del evaluador;
- documentos corregidos y sus hashes;
- el `WorkflowTaskEnvelope`;
- la fase terminal del wrapper; y
- eventos de evaluación y tarea asentada.

La implementación filesystem utiliza el mecanismo actual de locks, writes
temporales y rename, extendido a la relación entre runs. Nunca depende de una
escritura parcial en dos directorios para inferir que un hijo fue lanzado: la
reserva del padre es autoritativa y la creación del hijo es repetible.

## Flujo de ejecución

```text
validar y snapshottear
        │
        ▼
materializar wrapper y resolvedWith
        │
        ▼ commit de reserva
getOrCreateChildRun(child_run_id)
        │
        ▼ commit de relación
WorkflowController.start(child_run_id)
        │
        ▼ persistir referencia externa
observar o reconciliar run hijo
        │
        ▼
crear contexto terminal inmutable
        │
        ▼ persistir AttemptRecord launching
TaskExecutor.execute(evaluador)
        │
        ▼ commit atómico
succeeded | failed
        │
        ▼
join paralelo existente
```

Un wrapper consume un slot desde `child_running` hasta que su evaluación queda
asentada. La concurrencia interna del hijo depende de su propia definición y
no es contabilizada por `max_concurrency` del padre.

## Evaluación integrada

`WorkflowTaskEvaluator` reutiliza `TaskExecutor`, `AttemptRecord`,
`prepareAttempt`, `readResult` y `stageDocuments`. No agrega otra abstracción
de runtime.

El servicio construye un input estable con:

- `resolvedWith`;
- ID y objetivo del workflow hijo;
- estado y terminal alcanzado;
- resumen ordenado de estados, visitas, intentos y fallos;
- documentos y structured outputs comprometidos;
- hashes y rutas durables, nunca rutas temporales;
- `child_run_id`; y
- procedencia padre-hijo.

El prompt inicial y la identidad del runtime se incorporan al snapshot del
padre. Todos los intentos reciben el mismo contexto y escriben en un directorio
de salida limpio. Un fallo técnico consume presupuesto y puede reintentarse;
un resultado semántico válido `failed` es terminal.

El envelope asentado conserva:

```ts
interface WorkflowTaskEnvelope {
  id: string;
  childRunId: string;
  status: "succeeded" | "failed";
  outputs: Record<string, StructuredOutputReference>;
  documents: DocumentRecord[];
  error?: JsonValue;
}
```

Los artefactos del hijo son inmutables. Una corrección del evaluador produce
nuevos documentos propiedad del wrapper.

## Recuperación

La recuperación se decide únicamente desde registros durables:

| Frontera observada | Acción |
| --- | --- |
| Wrapper materializado sin reserva | Completar y persistir la reserva. |
| Identidad reservada sin run hijo | Crear el mismo hijo idempotentemente. |
| Hijo creado sin controlador | Lanzar el controlador para ese run. |
| Lanzamiento sin referencia adjunta | Recuperar por identidad estable antes de relanzar. |
| Controlador activo | Reconciliar y esperar el mismo proceso. |
| Hijo terminal sin evaluación | Crear el snapshot de evaluación e iniciarla. |
| Evaluación en `launching` o `running` | Recuperar el intento antes de consumir otro. |
| Intento técnicamente fallido | Aplicar delay e iniciar el siguiente intento permitido. |
| Evaluación válida asentada | No repetir; continuar con los demás wrappers. |
| Wrappers terminales sin join | Calcular y comprometer el join. |
| Join comprometido | Continuar desde la transición ya asentada. |

Si el estado externo de un controlador o evaluador es irreconciliablemente
incierto, el padre termina con fallo de motor. No se crea otro proceso de forma
optimista.

## Cancelación

`CancelWorkflow` amplía su búsqueda de trabajo activo para distinguir:

- intentos de agente, cancelados mediante `TaskExecutor`;
- intentos del evaluador, también cancelados mediante `TaskExecutor`; y
- controladores de runs hijos, cancelados mediante `WorkflowController`.

Primero persiste la intención de cancelación y después envía comandos externos.
Cada observación se registra con timestamp e identidad. Un hijo que ya llegó a
terminal no se reabre: solo se evita o cancela una evaluación todavía activa.

## Concurrencia y workspaces

El worker pool actual permanece en `ExecuteWorkflow` y `RecoverWorkflow`; cada
worker delega según el discriminante del trabajo. No se crea un pool dentro de
`WorkflowTaskCoordinator`.

En modo `direct`, cada hijo usa la raíz del proyecto como cualquier run normal.
En modo `worktree`, el proceso controlador hijo aplica
`ProjectWorkspaceCoordinator.prepareMain` a su propio run. El wrapper padre no
llama `prepareParallel` para crear un worktree de tarea de workflow, porque el
hijo es propietario de su workspace y cleanup.

Esta diferencia requiere que `ProjectWorkspaceCoordinator` continúe operando
solo sobre el run que recibe; no necesita conocer relaciones padre-hijo.

## Taxonomía de fallos

### Fallos de definición

Ocurren antes de crear el run:

- workflow registrado desconocido;
- ID interno diferente de la clave registrada;
- ruta fuera del proyecto;
- ciclo entre workflows;
- combinación de campos de agente y workflow;
- `with` inválido o vacío;
- `$item` fuera de `for_each`; y
- políticas de intento no permitidas en el wrapper.

### Fallos semánticos del wrapper

Generan un resultado válido `failed` y participan en el join:

- el evaluador concluye que el hijo no cumplió el objetivo; o
- el evaluador devuelve `failed` con error y documentos válidos.

### Fallos técnicos reintentables de evaluación

Consumen uno de los tres intentos:

- timeout;
- error confirmado del runtime;
- `result.json` ausente o inválido;
- outcome o documentos inválidos.

### Fallos de motor

Terminan el padre sin fabricar un outcome semántico:

- snapshot hijo ausente o corrupto;
- conflicto de procedencia o identidad;
- persistencia incierta de la relación padre-hijo;
- lanzamiento o cancelación externa irreconciliable;
- pérdida del lease o fencing token; y
- fallo al comprometer evaluación o join.

Los códigos estables concretos se centralizan junto a los errores de dominio y
puertos. No se derivan de mensajes del adaptador de proceso o filesystem.

## Observabilidad

El padre agrega los eventos definidos por la especificación:

- `child_run_reserved`;
- `child_run_started`;
- `child_run_settled`;
- `workflow_task_evaluation_started`; y
- `workflow_task_evaluation_settled`.

Los eventos incluyen siempre `stateId`, `visitNumber`, `taskId` y
`childRunId`. Los relacionados con procesos incluyen la identidad externa sin
copiar logs completos. Los eventos de intento, documentos, task settled y join
existentes conservan su formato y procedencia.

`RunPresenter.status` muestra por wrapper:

```text
task=<id> type=workflow phase=<phase> child_run=<id> attempts=<n>
```

`history` enlaza causalmente con el run hijo, pero el usuario consulta ese run
para obtener el detalle de sus estados e intentos.

## Modificaciones por archivo

### Dominio

#### `src/domain/execution/run.ts`

- Extender `RunRecord` con la referencia opcional al padre.
- Extender `ParallelTaskRecord` con una rama discriminada de ejecución de
  workflow.
- Representar `child_run_id`, bindings, referencia del controlador, intentos
  de evaluación y envelope.
- Adaptar `calculateParallelOutcome` para usar la fase terminal del wrapper sin
  cambiar el contrato público del join.

#### `src/domain/execution/workflow-task.ts` —nuevo

- Definir coordenadas, fases, envelope y política efectiva del evaluador.
- Implementar transiciones e invariantes puras del wrapper.
- Mantener este comportamiento separado de helpers generales de `run.ts`.

### Aplicación

#### `src/application/services/workflow-task-coordinator.ts` —nuevo

- Orquestar reserva, creación idempotente, proceso hijo, observación y
  evaluación.
- Exponer una operación para ejecución inicial y otra para recuperación del
  mismo wrapper.
- Traducir fallos de puertos a fallos de aplicación o motor estables.

#### `src/application/services/workflow-task-evaluator.ts` —nuevo

- Preparar el contexto terminal del hijo.
- Administrar intentos del evaluador con la política fija.
- Validar, stagear y devolver un envelope listo para commit.

#### `src/application/use-cases/execute-workflow.ts`

- Seleccionar trabajo de agente o workflow dentro del worker pool existente.
- Resolver bindings durante materialización.
- Delegar wrappers de workflow en `WorkflowTaskCoordinator`.
- Evitar preparar worktrees de tarea paralela para wrappers de workflow.

#### `src/application/use-cases/recover-workflow.ts`

- Recuperar por la fase durable y el discriminante de cada tarea.
- Delegar hijos y evaluaciones al coordinador compartido.
- Reconstruir el join desde envelopes ya asentados.

#### `src/application/use-cases/cancel-workflow.ts`

- Enumerar controladores hijos además de intentos de agentes.
- Cancelar y reconciliar cada clase de ejecución con su puerto correspondiente.
- Marcar wrappers en cola sin lanzar procesos.

#### `src/application/use-cases/inspect-runs.ts`

- Exponer en el resultado de consulta la fase y relación padre-hijo sin cargar
  recursivamente toda la historia del hijo.

### Puertos

#### `src/ports/project-definitions.ts`

- Agregar definiciones de registro, trabajo de workflow, bindings y evaluador.
- Cambiar tareas estáticas y templates dinámicos a la unión
  `AgentWorkDefinition | WorkflowWorkDefinition`.
- Representar dependencias hijas y sus artefactos dentro del snapshot efectivo.

#### `src/ports/run-repository.ts`

- Agregar contratos idempotentes de reserva y creación de runs hijos.
- Agregar preparación del contexto de evaluación y commit atómico del envelope.
- Conservar `load` como fuente autoritativa del estado terminal del hijo.

#### `src/ports/workflow-controller.ts` —nuevo

- Definir launch, referencias externas, recovery, cancelación y reconciliación
  de un proceso controlador de workflow.
- No exponer `ChildProcess`, PID obligatorio ni tipos de Node.js.

### Infraestructura de salida

#### `src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.ts`

- Aceptar la clave `workflows` del proyecto.
- Cargar y validar el registro y el grafo recursivo.
- Parsear las dos formas cerradas de trabajo paralelo.
- Validar y resolver el contrato de bindings.
- Emitir artefactos con IDs lógicos únicos por workflow.

#### `src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.ts`

- Persistir la referencia padre-hijo en ambos runs.
- Implementar reserva, creación y validación idempotentes bajo lock.
- Generar `context.md` del hijo con `resolvedWith`.
- Generar el contexto de evaluación desde artefactos durables verificados.
- Stagear documentos corregidos y comprometer el envelope de forma atómica.
- Normalizar snapshots anteriores sin asumir campos de submáquina.

#### `src/infrastructure/outbound/workflow-controller/process/process-workflow-controller.ts` —nuevo

- Lanzar un controlador de Happy Machine para un run ya creado.
- Capturar una referencia externa recuperable y logs diagnósticos.
- Implementar recuperación, cancelación y reconciliación sin interpretar reglas
  del workflow.

### Infraestructura de entrada y composición

#### `src/infrastructure/inbound/cli/run-presenter.ts`

- Mostrar tipo, fase y `child_run_id` de cada wrapper.
- Mantener el detalle del hijo fuera de la salida resumida del padre.

#### `src/composition-root.ts`

- Construir el adaptador `ProcessWorkflowController`.
- Inyectarlo en ejecución, recuperación y cancelación mediante los nuevos
  servicios.
- Mantener `main.ts` sin cambios de comportamiento.

## Estrategia de pruebas

### Definiciones

Ampliar `tests/project-definitions.test.ts` para cubrir:

- registro válido y dependencias transitivas;
- workflows desconocidos, IDs inconsistentes, rutas inseguras y ciclos;
- trabajo de agente y workflow en el mismo paralelo estático;
- exclusión mutua de campos;
- `with` literal, `$item`, mapas vacíos y valores no serializables; y
- ausencia de regresiones en definiciones existentes.

### Snapshots y persistencia

Ampliar `tests/run-snapshot.test.ts` y las pruebas del repositorio para cubrir:

- artefactos recursivos y hashes;
- recuperación sin releer YAML;
- reserva repetida con la misma identidad;
- rechazo de coordenadas o procedencias incompatibles;
- creación idempotente del hijo; y
- commit atómico del resultado del wrapper.

### Ejecución y concurrencia

Agregar `tests/workflow-submachines.test.ts` con un
`FakeWorkflowController` determinista para cubrir:

- cero, una y varias tareas estáticas y dinámicas;
- orden de materialización y límite `max_concurrency`;
- workflows hijos con ciclos, retries y paralelos internos;
- resultados semánticos `succeeded` y `failed`;
- política técnica `30m / 3 / 5s` del evaluador;
- corrección de documentos sin mutar artefactos del hijo;
- un único hijo por wrapper; y
- join all-settled con mezcla de resultados.

### Recuperación y cancelación

Ampliar `tests/durable-recovery.test.ts` y
`tests/durable-cancellation.test.ts` para interrumpir cada frontera de la tabla
de recuperación y comprobar:

- ausencia de runs y procesos duplicados;
- recuperación del intento activo del evaluador;
- reintento exclusivo de fallos técnicos;
- no repetición de un `failed` semántico;
- cancelación de wrappers en cola, hijos activos y evaluadores; y
- fallo seguro ante ejecución externa incierta.

### Observabilidad y regresión

Ampliar `tests/status-history-observability.test.ts` y
`tests/parallel-states.test.ts` para validar eventos, presentación, envelopes y
el join. Ejecutar además las suites existentes de fan-out dinámico, retries,
timeouts, cycles, worktrees, detach/resume y compatibilidad de snapshots.

## Orden recomendado de implementación

1. Modelo de dominio y tipos de definición, sin ejecución externa.
2. Parser del registro, validación recursiva y snapshots.
3. Persistencia idempotente de relaciones y runs hijos.
4. Puerto y adaptador del proceso controlador.
5. Evaluador integrado y su política durable.
6. Coordinación en ejecución y worker pool.
7. Recuperación y cancelación.
8. Observabilidad, regresión y conformance integral.

Cada etapa debe mantener compilación y pruebas existentes en verde. Los nuevos
campos persistidos deben ser opcionales durante la lectura de snapshots previos
hasta que una definición nueva materialice trabajo de workflow.

## Trazabilidad de aceptación

| Requisito funcional | Responsabilidad arquitectónica | Verificación principal |
| --- | --- | --- |
| Un workflow independiente por tarea | `WorkflowTaskCoordinator` + `WorkflowController` | Suite integral de submáquinas |
| Un único hijo por coordenada | Dominio + operaciones idempotentes del repositorio | Pruebas de crash en reserva/creación |
| Input inmutable | Resolución de bindings + snapshot/contexto durable | Pruebas de `$item` y recuperación |
| Evaluación `succeeded | failed` | `WorkflowTaskEvaluator` | Contrato y reintentos técnicos |
| Join all-settled existente | Worker pool y `calculateParallelOutcome` | Paralelos mixtos y vacíos |
| Ejecución en proceso independiente | Puerto `WorkflowController` | Adaptador falso y prueba de integración |
| Recuperación sin duplicados | Fases, identidades y reconciliación | Interrupción en cada frontera |
| Cancelación durable | `CancelWorkflow` + ambos puertos de ejecución | Cancelación en cola/activa/evaluando |
| Procedencia y auditoría | Enlaces, envelopes y eventos | Status/history y hashes |
| Compatibilidad previa | Normalización aditiva | Suite completa existente |

## Criterio de finalización arquitectónica

La implementación satisface esta arquitectura cuando una tarea paralela puede
seleccionar trabajo de agente o un workflow registrado; materializa y persiste
todos sus bindings antes de lanzar; crea exactamente un run hijo recuperable
en otro proceso; evalúa su resultado con intentos durables; produce un envelope
`succeeded | failed`; y participa en el scheduler y join existentes sin romper
la dirección de dependencias, duplicar procesos o modificar snapshots previos.
