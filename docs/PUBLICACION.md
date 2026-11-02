# Guía de publicación de Probato PR

Guía paso a paso para publicar la extensión por primera vez. Está pensada para alguien que nunca publicó una extensión de VS Code. Datos verificados el 2026-11-02 contra la documentación oficial; si pasó mucho tiempo, revisá los enlaces antes de seguir.

El proceso técnico (gate de calidad, empaquetado, pruebas del VSIX) está en [`RELEASE.md`](RELEASE.md). Esta guía cubre las cuentas, las decisiones y la publicación en sí.

## 0. Antes de empezar: qué tiene que estar listo

Publicar es público y casi todo lo que se hace en el Marketplace se puede corregir, pero **algunas cosas son permanentes**. Revisá [`PRODUCT_RELEASE_READINESS.md`](../PRODUCT_RELEASE_READINESS.md) y resolvé:

| Pendiente | Por qué importa |
|---|---|
| **Nombre** verificado (INPI clases 9 y 42) | El ID de la extensión (`armotusitio.probato-pr`) queda fijo. Cambiar de nombre después es publicar otra extensión y perder instalaciones y reseñas. |
| **Repositorio público** en GitHub | El logo del README y los enlaces (*Repository*, *Issues*) del Marketplace apuntan al repo. Si es privado, se ven rotos. |
| **Capturas** en el README | Es lo primero que mira alguien en la página. Sin capturas se instala mucho menos. |
| **Plan de pruebas manual** (`docs/MANUAL_TEST_PLAN.md`) | Lo que los tests automáticos no cubren: Restricted Mode, el panel con teclado y la IA con un proveedor real. |
| **Email de contacto** público | Aparece en `SECURITY.md`, `SUPPORT.md` y `PRIVACY.md`. |

La versión `0.1.0` ya está marcada como **Preview** (`"preview": true` en `package.json`): el Marketplace muestra la etiqueta *Preview*, que baja las expectativas mientras juntás opiniones de usuarios.

## 1. Decisiones permanentes (leelas antes de crear nada)

- **ID del publisher**: `armotusitio`. **No se puede cambiar nunca.** El *nombre visible* sí se puede cambiar.
- **Nombre de la extensión**: `probato-pr` (campo `name` de `package.json`). El ID completo es `armotusitio.probato-pr`.
- **"Unpublish" vs. "Remove"**: si algún día necesitás bajarla, usá **Unpublish** (deja de descargarse, conserva estadísticas y se puede volver a publicar). **Remove** es irreversible y el nombre queda reservado para siempre: no lo vas a poder volver a usar.
- **Versiones**: una versión publicada no se puede volver a subir. Si hay un error, se publica `0.1.1`.

## 2. Hacer público el repositorio

En GitHub: **Settings → General → Danger Zone → Change visibility → Public**.

Antes, revisá que no haya nada privado en el historial: `git log --stat` y buscá archivos que no deberían estar (claves, `.env`, reportes con datos de clientes). El archivo `probato-review.md` que exportaste al probar la extensión no está commiteado; dejalo fuera o borralo.

## 3. Crear la cuenta y el publisher (una sola vez)

1. Si no tenés, creá una **cuenta Microsoft** (sirve una de Outlook/Hotmail o tu email personal registrado en Microsoft).
2. Entrá a **https://marketplace.visualstudio.com/manage** con esa cuenta.
3. **Create publisher**:
   - **ID**: `armotusitio`
   - **Name**: `ArmoTuSitio`
   - Completá descripción, sitio (`https://armotusitio.com.ar`) y logo si lo pide. El logo del publisher puede ser `media/logo.png`.
4. Aceptá los términos del Marketplace.

## 4. Primera publicación (la forma más simple, sin tokens)

1. Generá el paquete con todas las verificaciones:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run package
   ```

   Si termina con `DONE Packaged: probato-pr.vsix`, está listo. Seguí también los pasos de prueba del VSIX de `RELEASE.md` (instalación limpia y suite de integración contra el VSIX extraído).
2. En **https://marketplace.visualstudio.com/manage/publishers/armotusitio** elegí **New extension → Visual Studio Code** y subí `probato-pr.vsix`.
3. El Marketplace escanea el paquete (virus y secretos). Tarda unos minutos; la extensión aparece como *Verifying* y después como publicada.
4. Comprobá la página pública: **https://marketplace.visualstudio.com/items?itemName=armotusitio.probato-pr**. Revisá logo, README, capturas, etiqueta *Preview*, licencia MIT y enlaces.
5. Instalala desde el Marketplace en un perfil limpio de VS Code (**Profiles → Create Profile → Empty**) y probá *Review Current Changes*.

## 5. Publicaciones siguientes: automáticas y sin tokens

> **Importante:** los *Personal Access Tokens* globales de Azure DevOps se retiran el **1 de diciembre de 2026**. Muchos tutoriales todavía explican `vsce login` con un PAT: **no uses ese método**.

La forma recomendada es **Trusted Publishing** con GitHub Actions: GitHub demuestra ante el Marketplace que el workflow es tuyo, sin guardar ninguna clave. El workflow es `.github/workflows/publish.yml`.

**Configuración (una sola vez):**

1. En la página del publisher, pestaña **Trusted Publishing**, creá una política:
   - Policy name: `Release workflow`
   - Provider: GitHub Actions
   - Repository owner: `Drako01`
   - Repository: `probato-pr` (solo el nombre, sin la URL)
   - Workflow: `publish.yml`
   - Environment: `marketplace`
2. En GitHub existen los environments `marketplace` y `open-vsx`, limitados a la rama `main`: ninguna otra rama puede usar sus credenciales. El token de Open VSX vive solo como secreto del environment `open-vsx` (`OVSX_PAT`).

**Cómo se publica una versión nueva:**

1. En tu PR subí la versión en `package.json` y documentala en `CHANGELOG.md`.
2. Mergeá el PR a `main`. Si la versión cambió, el workflow corre todos los chequeos, empaqueta **una sola vez** el VSIX y lo publica en el Marketplace y en Open VSX con ese mismo archivo. Después crea el release de GitHub con el VSIX y su SHA-256.
3. Si el merge no cambia la versión, el workflow solo verifica y no publica nada.
4. Para republicar o publicar la versión actual a mano: **Actions → publish → Run workflow**. Es seguro repetirlo: una versión que ya existe en un store se omite.

Cada pull request corre los chequeos en Linux y Windows. Si el repositorio fuera privado, el workflow tiene que correr dentro de las 48 horas de crear la política.

## 6. Open VSX: Cursor, Windsurf y VSCodium

Cursor, Windsurf, VSCodium y Gitpod **no usan** el Marketplace de Microsoft sino **Open VSX**. Es mucho público de desarrolladores que ya trabajan con IA, así que conviene publicar en los dos.

1. Iniciá sesión en **https://open-vsx.org** con tu cuenta de GitHub (`Drako01`).
2. Creá una cuenta en **eclipse.org** completando el campo *GitHub Username* con exactamente `Drako01`.
3. En tu perfil de open-vsx.org, vinculá la cuenta de Eclipse y **firmá el Publisher Agreement desde ese perfil**. Firmarlo solo en el sitio de Eclipse no alcanza.
4. En el perfil, **Access Tokens → Generate New Token**. Copialo y guardalo en un gestor de contraseñas, nunca en archivos del repo.
5. Creá el namespace y publicá el mismo VSIX (la primera vez a mano; después lo hace el workflow del paso 5, con el token guardado como secreto del environment `open-vsx`):

   ```bash
   OVSX_PAT=<token> npx ovsx create-namespace armotusitio
   OVSX_PAT=<token> npx ovsx publish probato-pr.vsix
   ```

6. Crear el namespace no te da exclusividad: pedí la propiedad del namespace (*claim ownership*, siguiendo la wiki de Open VSX) para que nadie más pueda publicar como `armotusitio`.

Para automatizarlo, agregá el token como secreto del environment `marketplace` en GitHub y un paso `npx ovsx publish probato-pr.vsix -p ${{ secrets.OVSX_TOKEN }}` al workflow.

## 7. Publisher verificado (tilde azul)

Da confianza, pero tiene requisitos de tiempo:

- Tener extensiones publicadas hace **al menos 6 meses**.
- Un dominio propio registrado hace al menos 6 meses (`armotusitio.com.ar`), sin subdominios, servido por HTTPS y respondiendo HTTP 200.

Cuando se cumpla: pestaña **Details** del publisher → **Verified domain** → **Save** → **Verify** → agregá el registro TXT en el DNS del dominio → **Verify** otra vez. Microsoft responde en hasta 5 días hábiles. Si cambiás el nombre visible del publisher, se pierde la verificación.

## 8. Después de publicar

- **Reseñas y preguntas**: respondelas desde la página del Marketplace; dan mucha confianza a los que llegan después.
- **Errores**: arreglá y publicá una versión de parche (`0.1.1`). No se puede reemplazar una versión ya publicada.
- **Canal pre-release** (opcional): `vsce publish --pre-release` publica una versión que solo reciben quienes la eligen. Convención habitual: versiones *minor* impares para pre-release (`0.3.x`) y pares para estables (`0.2.x`). No se admiten sufijos semver como `-beta`.
- **Quitar la etiqueta Preview**: cuando la extensión esté estable, poné `"preview": false` y publicá una versión nueva.

## Enlaces oficiales

- Publicar extensiones: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Referencia del manifiesto (`preview`, `pricing`, `galleryBanner`): https://code.visualstudio.com/api/references/extension-manifest
- Administración del Marketplace: https://marketplace.visualstudio.com/manage
- Open VSX, publicación: https://github.com/eclipse/openvsx/wiki/Publishing-Extensions
