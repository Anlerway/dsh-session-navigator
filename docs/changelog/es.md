Notas de la versión: V1.2.0-Alpha-V1

Cambios principales

Es una versión de vista previa. Gracias a quienes instalan y usan el plugin, y por la paciencia en cada versión; los informes de errores y las sugerencias son bienvenidos.

- Diez idiomas en la interfaz, ocho de ellos nuevos
- El plugin se reestructuró y el arranque en frío es mucho más rápido
- La lista no siempre se refrescaba al borrar una sesión; corregido
- Si falta el runtime, ahora se ofrece la descarga
- La carpeta de datos puede volver a la predeterminada
- Todos los diálogos usan ahora los de DSH

Los cambios en detalle

Novedades

- Ocho idiomas nuevos, diez en total (japonés, coreano, alemán, francés, español, ruso, portugués, chino tradicional)
- Barra de progreso de los resúmenes de IA
- Si falta el componente de Electron, se ofrece la descarga en el acto
- Ajustes › Carpeta de datos: cambiar de ubicación y volver a la predeterminada
- Las notas de la versión también están traducidas

Mejoras

- Arranque en frío 3,1 s → 0,12 s (dos mil sesiones); el reinicio lee el manifiesto de sesiones
- Actualizar lee solo los archivos cambiados; una respuesta ya no dispara un barrido completo
- Las listas largas solo crean las filas visibles; la primera pantalla ahorra más de cincuenta mil elementos
- Cabecera y estadísticas de la sesión en caché por versión de archivo
- La indexación cede el hilo principal cada 150 ms y limita el texto por sesión
- El resaltado al pasar el ratón responde al instante
- Borrar caché cubre dos elementos más: manifiesto de sesiones e índice de contenido
- Los diálogos usan los nativos de DSH
- Algunos textos revisados

Correcciones

- Borrar sesiones: las abiertas también van a la papelera, no caen en «Sin grupo» y no dejan carpetas vacías
- El panel se quedaba en blanco a veces
- Una sesión borrada seguía en el espacio de trabajo
- La ventana del explorador retenía el proceso de DSH
- Los márgenes del menú de fila no coincidían con los del menú del host
- El runtime se mostraba como Electron
- El progreso de descarga del componente ahora empieza al hacer clic
