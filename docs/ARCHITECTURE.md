# Happy Machine Architecture

## Purpose

This document defines the structural rules for the Happy Machine codebase. It establishes the available architectural layers, the responsibility of each layer, the permitted dependency direction, and the required location for every kind of code.

It is intentionally independent of current and future functionality. Adding behavior does not create a new architectural layer. New code must be divided among the existing layers according to the responsibilities defined here.

The terms **MUST**, **MUST NOT**, and **MAY** are normative.

## Architecture Model

Happy Machine is a modular monolith that follows ports-and-adapters architecture. It is distributed as one TypeScript package, but its source code is divided into explicit architectural boundaries.

```text
Inbound adapter ──▶ Application ──▶ Domain
                         │
                         ▼
                       Port ◀── Outbound adapter

                Composition Root wires all parts
```

The dependency direction always points toward the business rules:

- The Domain is the innermost layer.
- The Application layer uses the Domain and declares its external needs through Ports.
- Infrastructure connects external technologies to the Application and Ports.
- The Composition Root selects and connects concrete implementations.

## Required Source Layout

The production source tree MUST use these top-level locations:

```text
src/
├── domain/
│   └── <domain-capability>/
├── application/
│   ├── use-cases/
│   └── services/
├── ports/
├── infrastructure/
│   ├── inbound/
│   │   └── <interface>/
│   └── outbound/
│       └── <capability>/
│           └── <technology>/
├── composition-root.ts
└── main.ts
```

These top-level directories are fixed. A change MUST NOT introduce another top-level directory under `src/`.

Directories represented by angle brackets are created only when corresponding code exists:

- `<domain-capability>` names a cohesive business concept.
- `<interface>` names an entry mechanism such as a CLI, HTTP interface, or user interface.
- `<capability>` names the external capability required by the Application.
- `<technology>` names the concrete implementation of that capability.

Empty directories and speculative modules MUST NOT be created for possible future behavior.

## Layer Directives

### Domain

**Required location:** `src/domain/`

#### Responsibility

The Domain owns business concepts, state, behavior, and invariants. Domain behavior must remain valid when every external technology and user interface is replaced.

#### Code that MUST be placed here

- Entities with identity and behavior.
- Value objects defined by their value.
- Domain services that enforce rules involving multiple domain objects.
- Domain policies and calculations.
- Domain events that describe facts meaningful to the business.
- Invariant validation and valid state transitions.
- Domain-specific errors.

#### Allowed dependencies

- Other Domain modules.
- TypeScript and runtime primitives that perform no I/O.

#### Prohibited dependencies

Domain code MUST NOT import:

- Application modules.
- Port contracts.
- Infrastructure modules.
- Frameworks, SDKs, database clients, filesystem APIs, process APIs, or UI libraries.
- Transport, persistence, configuration, or vendor-specific types.

Domain code MUST NOT read files, access the network, query a database, inspect environment variables, or depend on the system clock directly.

#### Organization rule

Domain code MUST be grouped by cohesive domain capability, not by technical artifact type. A capability directory MAY contain its entities, value objects, policies, events, and errors. Generic top-level directories such as `entities/`, `models/`, or `utils/` MUST NOT be used to mix unrelated capabilities.

### Application

**Required location:** `src/application/`

#### Responsibility

The Application layer owns use-case orchestration. It receives a request from an inbound adapter, coordinates Domain behavior and Ports, and returns an application result.

The Application decides the order of operations. The Domain decides whether those operations are valid.

#### Code that MUST be placed here

- Use cases that represent callable application operations.
- Application request and result types.
- Coordination spanning multiple domain objects or external capabilities.
- Application services shared by more than one use case.
- Transaction and concurrency boundaries expressed through Ports.
- Translation of Domain failures into application-level failures.

#### Required subdirectories

- `src/application/use-cases/` contains callable application operations.
- `src/application/services/` contains orchestration reused by multiple use cases.

A helper used by only one use case MUST stay next to that use case. It MUST NOT be moved into `services/` merely to shorten a file.

#### Allowed dependencies

- Domain modules.
- Port contracts.
- Other Application modules.

#### Prohibited dependencies

Application code MUST NOT import:

- Infrastructure modules.
- Framework, SDK, database, filesystem, process, or UI types.
- Concrete adapter implementations.

Application code MUST NOT parse transport input, render interface output, execute SQL, manipulate technology-specific paths, or construct its concrete dependencies.

### Ports

**Required location:** `src/ports/`

#### Responsibility

Ports define the external capabilities required by the Application. They are owned by the inside of the architecture and implemented by outbound Infrastructure adapters.

A Port describes what the Application needs. It MUST NOT mirror the API of a selected vendor, SDK, or storage engine.

#### Code that MUST be placed here

- Interfaces for required external side effects or resources.
- Port request and result types.
- Technology-independent errors produced by an external capability.

#### Allowed dependencies

- Domain types when they are part of the capability contract.
- TypeScript and runtime primitives that perform no I/O.

#### Prohibited dependencies

Port code MUST NOT import:

- Application implementations.
- Infrastructure modules.
- Vendor, framework, SDK, transport, database, or filesystem types.

A Port MUST NOT contain implementation logic, select a technology, or expose configuration belonging to a concrete adapter.

#### Organization rule

Each Port MUST represent one cohesive external capability. Its name MUST describe that capability rather than a database, vendor, framework, or other implementation technology.

### Infrastructure

**Required location:** `src/infrastructure/`

#### Responsibility

Infrastructure owns all interaction with the outside world. It translates between external representations and the technology-independent types owned by Application, Domain, and Ports.

Infrastructure is divided into inbound and outbound adapters.

#### Inbound adapters

**Required location:** `src/infrastructure/inbound/<interface>/`

Inbound adapters receive input and invoke Application use cases. Controllers, command handlers, transport DTOs, input validation, authentication tied to an interface, presentation, and exit or status-code mapping belong here.

An inbound adapter:

1. Parses and validates interface-level input.
2. Converts that input into an Application request.
3. Invokes exactly one use case per controller action.
4. Converts the Application result into interface output.

Inbound adapters MAY import Application entry points and their request and result types. They MUST NOT modify Domain state directly, coordinate multiple use cases to implement business behavior, or contain business rules.

#### Outbound adapters

**Required location:** `src/infrastructure/outbound/<capability>/<technology>/`

Outbound adapters implement Ports using concrete technologies. Client initialization, queries, file access, process invocation, serialization, vendor configuration, migrations, and mappings between vendor and internal types belong here.

An outbound adapter:

1. Implements one or more closely related Ports.
2. Accepts only the technology-independent types declared by its Port.
3. Converts those types into the external technology's representation.
4. Converts external results and failures back into Port types.
5. Prevents vendor types from crossing the adapter boundary.

Outbound adapters MAY import their implemented Ports and the Domain types referenced by those Ports. They MUST NOT import Application use-case implementations or other concrete adapters.

#### Adapter isolation rule

Code used by one adapter MUST remain inside that adapter. Shared Infrastructure code MAY be extracted only when at least two adapters use it for the same reason. Extracted code MUST remain under `src/infrastructure/`; it MUST NOT be moved into Domain, Application, or Ports to make a technology dependency appear reusable.

### Composition Root

**Required location:** `src/composition-root.ts`

#### Responsibility

The Composition Root selects concrete adapters, creates all runtime objects, injects dependencies, and returns the fully assembled process entry point.

It is the only production module allowed to import every layer.

#### Directives

- All concrete dependency construction MUST occur here or in factory modules called only from here.
- Environment and deployment configuration MAY be read here and passed into adapter constructors.
- Business rules, use-case orchestration, input parsing, and adapter behavior MUST NOT be implemented here.
- Application and Domain modules MUST NOT access a global dependency container or service locator.

### Process Entry Point

**Required location:** `src/main.ts`

#### Responsibility

The Process Entry Point starts the application assembled by the Composition Root.

#### Directives

- `main.ts` MUST remain minimal.
- It MAY invoke the process entry point returned by the Composition Root and map unrecoverable startup errors to process termination.
- It MUST NOT contain business rules, use-case orchestration, dependency construction, or adapter implementation.

## Dependency Matrix

The following matrix is mandatory:

| Source module | May import |
| --- | --- |
| `domain` | `domain` |
| `application` | `application`, `domain`, `ports` |
| `ports` | `ports`, `domain` |
| Inbound `infrastructure` | `application` and interface-local Infrastructure code |
| Outbound `infrastructure` | `ports`, Port-referenced `domain` types, and adapter-local Infrastructure code |
| `composition-root.ts` | All layers |
| `main.ts` | `composition-root.ts` |

An import not explicitly allowed by this table is prohibited.

## Boundary Ownership

Types and errors MUST be owned by the layer that gives them meaning:

| Concern | Owner |
| --- | --- |
| Business state and invariants | Domain |
| Use-case request, result, and application failure | Application |
| External capability contract and technology-independent capability failure | Ports |
| Transport DTO, CLI option, status code, and presentation model | Inbound Infrastructure |
| Database record, file format, SDK response, and vendor error | Outbound Infrastructure |
| Concrete construction configuration | Composition Root or the owning adapter |

External representations MUST be converted at the boundary. A transport DTO, database record, SDK response, or vendor error MUST NOT cross into Domain or Application code.

## Code-Placement Procedure

Every new module MUST be placed by applying these questions in order:

1. **Does it express a business concept, rule, invariant, or state transition?**  
   Place it in `src/domain/<domain-capability>/`.

2. **Does it coordinate a callable operation using Domain behavior and external capabilities?**  
   Place it in `src/application/use-cases/`. If the coordination is reused by multiple use cases, place it in `src/application/services/`.

3. **Does the Application require an external capability to perform that operation?**  
   Define the technology-independent contract in `src/ports/`.

4. **Does it receive input or present output through a particular interface?**  
   Place it in `src/infrastructure/inbound/<interface>/`.

5. **Does it implement a Port using a concrete technology?**  
   Place it in `src/infrastructure/outbound/<capability>/<technology>/`.

6. **Does it select or construct concrete implementations?**  
   Place it in `src/composition-root.ts` or a factory used only by that module.

7. **Does it only start the assembled process?**  
   Place it in `src/main.ts`.

If a module answers more than one question, it has more than one responsibility and MUST be split at the architectural boundary.

## Change Integration Rule

A functional change is distributed across existing layers according to responsibility; it does not create a new layer:

```text
Business rule                  → domain/<domain-capability>/
Use-case orchestration         → application/use-cases/
Required external capability  → ports/
Input or presentation          → infrastructure/inbound/<interface>/
Technology implementation     → infrastructure/outbound/<capability>/<technology>/
Dependency wiring             → composition-root.ts
```

A change MUST add code only to the rows it actually requires. It MUST NOT add pass-through modules to every layer for symmetry.

## Enforcement

Architecture rules MUST be enforced during code review and, when source code exists, with automated import-boundary checks.

A change is architecturally invalid when it:

- Introduces an import prohibited by the Dependency Matrix.
- Places business behavior in an adapter or controller.
- Leaks an external type across its adapter boundary.
- Performs I/O without a Port owned by the inside of the architecture.
- Constructs a concrete dependency outside the Composition Root.
- Adds a generic shared module without a single clear owner.
- Creates speculative code or directories for behavior that does not exist.
