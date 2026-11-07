# Guía de publicación de Probato PR

Guía paso a paso para publicar la extensión por primera vez. Está pensada para alguien que nunca publicó una extensión
de VS Code. Datos verificados el 2026-11-02 contra la documentación oficial; si pasó mucho tiempo, revisá los enlaces
antes de seguir.

El proceso técnico (gate de calidad, empaquetado, pruebas del VSIX) está en [`RELEASE.md`](RELEASE.md). Esta guía
cubre las cuentas, las decisiones y la publicación en sí.

## 0. Antes de empezar: qué tiene que estar listo

Publicar es público y casi todo lo que se hace en el Marketplace se puede corregir, pero **algunas cosas son
permanentes**. Revisá [`PRODUCT_RELEASE_READINESS.md`](../PRODUCT_RELEASE_READINESS.md) y resolvé:

| Pendiente | Por qué importa |
|---|---|
| **Nombre** verificado (INPI clases 9 y 42) | El ID de la extensión (`armotusitio.probato-pr`) queda fijo. Cambiar de nombre después es publicar otra extensión y perder instalaciones y reseñas. |
| **Repositorio público** en GitHub | El logo del README y los enlaces (*Repository*, *Issues*) del Marketplace apuntan al repo. Si es privado, se ven rotos. |
| **Capturas** en el README | Es lo primero que mira alguien en la página. Sin capturas se instala mucho menos. |
| **Plan de pruebas manual** (`docs/MANUAL_TEST_PLAN.md`) | Lo que los tests automáticos no cubren: Restricted Mode, el panel con teclado y la IA con un proveedor real. |
| **Email de contacto** público | Aparece en `SECURITY.md`, `SUPPORT.md` y `PRIVACY.md`. |

Desde la `0.6.0` la extensión ya no está marcada como **Preview**. Hasta la `0.5.0` el manifiesto tenía
`"preview": true`, que muestra la etiqueta *Preview* en el Marketplace.

## 1. Decisiones permanentes (leelas antes de crear nada)

- **ID del publisher**: `armotusitio`. **No se puede cambiar nunca.** El *nombre visible* sí se puede cambiar.
- **Nombre de la extensión**: `probato-pr` (campo `name` de `package.json`). El ID completo es `armotusitio.probato-pr`.
- **"Unpublish" vs. "Remove"**: si algún día necesitás bajarla, usá **Unpublish** (deja de descargarse, conserva
  estadísticas y se puede volver a publicar). **Remove** es irreversible y el nombre queda reservado para siempre: no
  lo vas a poder volver a usar.
- **Versiones**: una versión publicada no se puede volver a subir. Si hay un error, se publica `0.1.1`.

## 2. Hacer público el repositorio

En GitHub: **Settings → General → Danger Zone → Change visibility → Public**.

Antes, revisá que no haya nada privado en el historial: `git log --stat` y buscá archivos que no deberían estar
(claves, `.env`, reportes con datos de clientes). El archivo `probato-review.md` que exportaste al probar la extensión
no está commiteado; dejalo fuera o borralo.

## 3. Crear la cuenta y el publisher (una sola vez)

1. Si no tenés, creá una **cuenta Microsoft** (sirve una de Outlook/Hotmail o tu email personal registrado en
   Microsoft).
2. Entrá a **[Marketplace](https://marketplace.visualstudio.com/manage)** con esa cuenta.
3. **Create publisher**:
   - **ID**: `armotusitio`
   - **Name**: `ArmoTuSitio`
   - Completá descripción, sitio (`https://armotusitio.com.ar`) y logo si lo pide. El logo del publisher puede ser
     `media/logo.png`.
4. Aceptá los términos del Marketplace.

## 4. Primera publicación (la forma más simple, sin tokens)

1. Generá el paquete con todas las verificaciones:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run package
   ```

   Si termina con `DONE Packaged: probato-pr.vsix`, está listo. Seguí también los pasos de prueba del VSIX de
   `RELEASE.md` (instalación limpia y suite de integración contra el VSIX extraído).
2. En **[Marketplace](https://marketplace.visualstudio.com/manage/publishers/armotusitio)** elegí **New extension →
   Visual Studio Code** y subí `probato-pr.vsix`.
3. El Marketplace escanea el paquete (virus y secretos). Tarda unos minutos; la extensión aparece como *Verifying* y
   después como publicada.
4. Comprobá la página pública:
   **[Marketplace](https://marketplace.visualstudio.com/items?itemName=armotusitio.probato-pr)**. Revisá logo, README,
   capturas, etiqueta *Preview*, licencia MIT y enlaces.
5. Instalala desde el Marketplace en un perfil limpio de VS Code (**Profiles → Create Profile → Empty**) y probá
   *Review Current Changes*.

## 5. Publicaciones siguientes: automáticas y sin tokens

> **Importante:** los *Personal Access Tokens* globales de Azure DevOps se retiran el **1 de diciembre de 2026**.
  Muchos tutoriales todavía explican `vsce login` con un PAT: **no uses ese método**.

La forma recomendada es **Trusted Publishing** con GitHub Actions: GitHub demuestra ante el Marketplace que el
workflow es tuyo, sin guardar ninguna clave. El workflow es `.github/workflows/publish.yml`.

**Configuración (una sola vez):**

1. En la página del publisher, pestaña **Trusted Publishing**, creá una política:
   - Policy name: `Release workflow`
   - Provider: GitHub Actions
   - Repository owner: `Drako01`
   - Repository: `probato-pr` (solo el nombre, sin la URL)
   - Workflow: `publish.yml`
   - Environment: `marketplace`
2. En GitHub existen los environments `marketplace` y `open-vsx`, limitados a la rama `main`: ninguna otra rama puede
   usar sus credenciales. Ambos stores usan OIDC/Trusted Publishing; el job de Open VSX no recibe un PAT.

**Cómo se publica una versión nueva:**

1. En tu PR subí la versión en `package.json` y documentala en `CHANGELOG.md`.
2. Mergeá el PR a `main`. Si la versión cambió, el workflow corre todos los chequeos, empaqueta **una sola vez** el
   VSIX y lo publica en el Marketplace y en Open VSX con ese mismo archivo. Después crea el release de GitHub con el
   VSIX y su SHA-256.
3. Si el merge no cambia la versión, el workflow solo verifica y no publica nada.

   **Open VSX no bloquea el release.** Si Open VSX tarda o retiene la versión (namespace sin verificar, escaneo), el
   release de GitHub se crea igual y el job de Open VSX deja una advertencia. Un job diario del mismo `publish.yml`
   reintenta, cierra su issue cuando la versión queda activa y abre uno si pasan 3 días sin que se active.
4. Para republicar o publicar la versión actual a mano: **Actions → publish → Run workflow**. Es seguro repetirlo: una
   versión que ya existe en un store se omite.

Cada pull request corre los chequeos en Linux, macOS y Windows. Si el repositorio fuera privado, el workflow tiene que
correr dentro de las 48 horas de crear la política.

## 6. Open VSX con Trusted Publishing

La extensión se publica también en Open VSX para los IDE que consultan ese registro. La cuenta debe tener la
propiedad del namespace, el Publisher Agreement firmado y una versión publicada antes de registrar la confianza.

En **Open VSX → Trusted Publishers**, registrá una sola entrada para `armotusitio/probato-pr`:

| Campo | Valor |
|---|---|
| Provider | GitHub |
| Organization or User name | `Drako01` |
| Repository name | `probato-pr` |
| Workflow filename | `publish.yml` |
| Environment name | `open-vsx` |

El nombre del workflow incluye la extensión `.yml`. Open VSX permite un Trusted Publisher por extensión:
la publicación normal y la sincronización diaria están en el mismo archivo, por lo que usan este único registro.
No registres `open-vsx-sync.yml`; ese workflow separado fue retirado.

El job solicita `id-token: write` y ejecuta el publicador con `--trusted-publishing`. El subproceso elimina las
variables de PAT para que no tengan prioridad sobre OIDC. No se guarda ningún token de publicación permanente.
Si migrás desde PAT, eliminá el secreto viejo cuando hayas comprobado la publicación OIDC; no lo copies al repo.

Para sincronizar solo el último release: **Actions → publish → Run workflow → open_vsx_sync**. La ejecución
programada usa el mismo job. Una falta de registro, environment incorrecto o identidad no autorizada debe fallar;
no se cambia automáticamente a un token permanente.

La configuración de cuenta y una publicación real son verificaciones distintas de las pruebas locales del script.
Consultá la [guía oficial del CLI de Open
VSX](https://github.com/eclipse-openvsx/openvsx/tree/main/cli#trusted-publishing).

## 7. Publisher verificado (tilde azul)

Da confianza, pero tiene requisitos de tiempo:

- Tener extensiones publicadas hace **al menos 6 meses**.
- Un dominio propio registrado hace al menos 6 meses (`armotusitio.com.ar`), sin subdominios, servido por HTTPS y
  respondiendo HTTP 200.

Cuando se cumpla: pestaña **Details** del publisher → **Verified domain** → **Save** → **Verify** → agregá el registro
TXT en el DNS del dominio → **Verify** otra vez. Microsoft responde en hasta 5 días hábiles. Si cambiás el nombre
visible del publisher, se pierde la verificación.

## 8. Después de publicar

- **Reseñas y preguntas**: respondelas desde la página del Marketplace; dan mucha confianza a los que llegan después.
- **Errores**: arreglá y publicá una versión de parche (`0.1.1`). No se puede reemplazar una versión ya publicada.
- **Canal pre-release** (opcional): `vsce publish --pre-release` publica una versión que solo reciben quienes la
  eligen. Convención habitual: versiones *minor* impares para pre-release (`0.3.x`) y pares para estables (`0.2.x`).
  No se admiten sufijos semver como `-beta`.
- **Etiqueta Preview**: se quitó en la `0.6.0` eliminando `"preview": true` del `package.json`. Para volver a
  mostrarla, agregá `"preview": true` y publicá una versión nueva.

## Enlaces oficiales

- Publicar extensiones: [Documentación
  oficial](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- Referencia del manifiesto (`preview`, `pricing`, `galleryBanner`): [Documentación
  oficial](https://code.visualstudio.com/api/references/extension-manifest)
- Administración del Marketplace: [Marketplace](https://marketplace.visualstudio.com/manage)
- Open VSX, publicación: [Open VSX](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)
