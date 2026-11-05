/* Host chrome translations are separate from content-type translations. */
const supported = ['en', 'ru', 'es', 'ka'];
const queries = new URLSearchParams(location.search).getAll('lang');
const query = queries.length === 1 ? queries[0] : undefined;
const normalized = query?.trim().toLowerCase().split(/[-_]/)[0];
export const requestedLanguage = supported.includes(normalized)
  ? normalized
  : '';
export const language = requestedLanguage || 'en';

// English remains the fallback for messages supplied by upstream libraries.
const messages = {
  'Interactive Content Editor': [
    'Редактор интерактивных материалов',
    'Editor de contenido interactivo',
    'ინტერაქტიული მასალის რედაქტორი'
  ],
  'Library upgrade': [
    'Обновление библиотеки',
    'Actualizar biblioteca',
    'ბიბლიოთეკის განახლება'
  ],
  Upgrade: ['Обновить', 'Actualizar', 'განახლება'],
  Dismiss: ['Скрыть', 'Descartar', 'დამალვა'],
  'Loading editor…': [
    'Загрузка редактора…',
    'Cargando el editor…',
    'რედაქტორი იტვირთება…'
  ],
  'Review the upgrade': [
    'Посмотреть обновление',
    'Revisar actualización',
    'განახლების ნახვა'
  ],
  Close: ['Закрыть', 'Cerrar', 'დახურვა'],
  'Open-source licenses': [
    'Лицензии открытого ПО',
    'Licencias de código abierto',
    'ღია კოდის ლიცენზიები'
  ],
  'Upgrading…': ['Обновление…', 'Actualizando…', 'ახლდება…'],
  'The editor model is incomplete.': [
    'Модель редактора неполная.',
    'El modelo del editor está incompleto.',
    'რედაქტორის მოდელი არასრულია.'
  ],
  'The editor runtime failed to load.': [
    'Не удалось загрузить редактор.',
    'No se pudo cargar el editor.',
    'რედაქტორის ჩატვირთვა ვერ მოხერხდა.'
  ],
  'The editor did not finish loading.': [
    'Редактор не завершил загрузку.',
    'El editor no terminó de cargar.',
    'რედაქტორის ჩატვირთვა არ დასრულებულა.'
  ],
  'The editor session has expired; try again once it is renewed.': [
    'Сессия редактора истекла; повторите после её обновления.',
    'La sesión del editor ha caducado; inténtalo de nuevo cuando se renueve.',
    'რედაქტორის სესიის ვადა ამოიწურა; განახლების შემდეგ სცადეთ ხელახლა.'
  ],
  'Choose a content type before saving.': [
    'Выберите тип материала перед сохранением.',
    'Selecciona un tipo de contenido antes de guardar.',
    'შენახვამდე აირჩიეთ მასალის ტიპი.'
  ],
  'Enter a title before saving.': [
    'Введите название перед сохранением.',
    'Introduce un título antes de guardar.',
    'შენახვამდე შეიყვანეთ სათაური.'
  ],
  'There is nothing to save yet.': [
    'Пока нечего сохранять.',
    'Todavía no hay nada que guardar.',
    'ჯერ შესანახი არაფერია.'
  ],
  'The content is being upgraded. Save again once the upgrade has finished.': [
    'Материал обновляется. Повторите сохранение после завершения обновления.',
    'El contenido se está actualizando. Vuelve a guardar cuando termine.',
    'მასალა ახლდება. დასრულების შემდეგ ხელახლა შეინახეთ.'
  ],
  'The content is being saved. Upgrade once the save has finished.': [
    'Материал сохраняется. Обновите после завершения сохранения.',
    'El contenido se está guardando. Actualízalo cuando termine.',
    'მასალა ინახება. განაახლეთ შენახვის დასრულების შემდეგ.'
  ],
  'The editor has not finished loading. Upgrade once it has.': [
    'Редактор ещё загружается. Обновите после завершения загрузки.',
    'El editor todavía se está cargando. Actualízalo cuando termine.',
    'რედაქტორი ჯერ იტვირთება. განაახლეთ ჩატვირთვის დასრულების შემდეგ.'
  ],
  'The editor is still uploading or loading. Upgrade once it has finished.': [
    'Редактор ещё передаёт или загружает данные. Дождитесь завершения.',
    'El editor todavía está cargando datos. Espera a que termine.',
    'რედაქტორი ჯერ ტვირთავს მონაცემებს. დაელოდეთ დასრულებას.'
  ],
  'There is nothing to upgrade yet.': [
    'Пока нечего обновлять.',
    'Todavía no hay nada que actualizar.',
    'ჯერ გასაახლებელი არაფერია.'
  ],
  'The upgrade did not finish in time.': [
    'Время ожидания обновления истекло.',
    'La actualización no terminó a tiempo.',
    'განახლების მოლოდინის დრო ამოიწურა.'
  ],
  'The content changed while it was upgraded; try again.': [
    'Материал изменился во время обновления; повторите попытку.',
    'El contenido cambió durante la actualización; inténtalo de nuevo.',
    'განახლებისას მასალა შეიცვალა; სცადეთ ხელახლა.'
  ],
  'The media size check timed out. Try the upload again.': [
    'Время проверки размера файла истекло. Повторите загрузку.',
    'Se agotó el tiempo para comprobar el tamaño. Vuelve a subir el archivo.',
    'ფაილის ზომის შემოწმების დრო ამოიწურა. ხელახლა ატვირთეთ.'
  ],
  'Upgrade the content to edit it': [
    'Обновите материал для редактирования',
    'Actualiza el contenido para editarlo',
    'რედაქტირებისთვის განაახლეთ მასალა'
  ],
  'This content cannot be opened': [
    'Не удалось открыть материал',
    'No se puede abrir este contenido',
    'ამ მასალის გახსნა შეუძლებელია'
  ],
  'This content uses library versions that this editor cannot open. Upgrade it to the installed versions listed below; a part nested in another moves to the version the enclosing content type accepts. The upgraded content opens in the editor unsaved: nothing changes until you save it.':
    [
      'Материал использует версии библиотек, которые редактор не может открыть. Обновите их до указанных ниже установленных версий. Вложенные части перейдут на версии, поддерживаемые их контейнером. Изменения вступят в силу после сохранения.',
      'El contenido usa versiones que este editor no puede abrir. Actualízalo a las versiones instaladas indicadas abajo; las partes anidadas usarán las versiones aceptadas por su contenedor. Los cambios se aplicarán al guardar.',
      'მასალა იყენებს ბიბლიოთეკების ვერსიებს, რომლებსაც რედაქტორი ვერ ხსნის. განაახლეთ ქვემოთ ჩამოთვლილ დაყენებულ ვერსიებზე. ჩაშენებული ნაწილები მათ კონტეინერთან თავსებად ვერსიებზე გადავა. ცვლილებები შენახვის შემდეგ ამოქმედდება.'
    ],
  'This content uses library versions that this editor cannot open, and no newer installed version can replace those marked below. Replace the content with a package made for the installed libraries.':
    [
      'Материал использует неподдерживаемые версии библиотек; для отмеченных ниже нет установленной замены. Замените материал пакетом для установленных библиотек.',
      'El contenido usa versiones no compatibles y no hay versiones instaladas que sustituyan las indicadas. Reemplázalo por un paquete compatible con las bibliotecas instaladas.',
      'მასალა იყენებს შეუთავსებელ ვერსიებს, რომელთა ჩანაცვლებაც დაყენებული ვერსიებით შეუძლებელია. ჩაანაცვლეთ დაყენებულ ბიბლიოთეკებთან თავსებადი პაკეტით.'
    ],
  'The editor runtime is outdated. Reload the page to enable media size checks.':
    [
      'Версия редактора устарела. Перезагрузите страницу, чтобы включить проверку размера файлов.',
      'El editor está desactualizado. Recarga la página para activar la comprobación del tamaño de los archivos.',
      'რედაქტორის ვერსია მოძველებულია. ფაილების ზომის შემოწმების ჩასართავად ხელახლა ჩატვირთეთ გვერდი.'
    ],
  'The editor is not ready.': [
    'Редактор ещё не готов.',
    'El editor todavía no está listo.',
    'რედაქტორი ჯერ მზად არ არის.'
  ],
  'The editor did not respond to the save request. Try again.': [
    'Редактор не ответил на запрос сохранения. Повторите попытку.',
    'El editor no respondió a la solicitud de guardado. Inténtalo de nuevo.',
    'რედაქტორმა შენახვის მოთხოვნას არ უპასუხა. სცადეთ ხელახლა.'
  ],
  'This editor was opened without a valid parent origin and cannot load.': [
    'Редактор открыт без допустимого адреса родительского приложения и не может загрузиться.',
    'El editor se abrió sin un origen válido de la aplicación principal y no puede cargarse.',
    'რედაქტორი გაიხსნა მთავარი აპლიკაციის მართებული მისამართის გარეშე და ვერ ჩაიტვირთება.'
  ],
  'This editor was opened with an unusable creation grant, so the new content cannot be saved. Open the editor again.':
    [
      'Редактор открыт с недействительным разрешением на создание, поэтому новый материал нельзя сохранить. Откройте редактор заново.',
      'El editor se abrió con un permiso de creación no válido y no se puede guardar el contenido nuevo. Abre el editor de nuevo.',
      'რედაქტორი გაიხსნა შექმნის არამოქმედი ნებართვით, ამიტომ ახალი მასალა ვერ შეინახება. ხელახლა გახსენით რედაქტორი.'
    ],
  'The H5P host did not answer the save request in time. The save may still complete; the next save will pick up its answer instead of creating a duplicate. Try again.':
    [
      'Сервис H5P не ответил на запрос сохранения вовремя. Сохранение ещё может завершиться; следующая попытка получит его результат без создания дубликата. Повторите попытку.',
      'El servicio H5P no respondió a tiempo. El guardado puede completarse; el siguiente intento recuperará su resultado sin crear un duplicado. Inténtalo de nuevo.',
      'H5P სერვისმა შენახვის მოთხოვნას დროულად არ უპასუხა. შენახვა შეიძლება დასრულდეს; შემდეგი მცდელობა მის შედეგს მიიღებს დუბლიკატის შექმნის გარეშე. სცადეთ ხელახლა.'
    ],
  'The H5P host returned an invalid save response. The save may have completed; try again to recover its result.':
    [
      'Сервис H5P вернул некорректный ответ на сохранение. Материал мог сохраниться; повторите попытку, чтобы получить результат.',
      'El servicio H5P devolvió una respuesta de guardado no válida. El guardado puede haberse completado; inténtalo de nuevo para recuperar el resultado.',
      'H5P სერვისმა შენახვაზე არასწორი პასუხი დააბრუნა. შენახვა შეიძლება დასრულდა; შედეგის მისაღებად სცადეთ ხელახლა.'
    ],
  'The editor session expired before the content could be upgraded for saving.':
    [
      'Сессия редактора истекла до обновления материала для сохранения.',
      'La sesión del editor caducó antes de actualizar el contenido para guardarlo.',
      'რედაქტორის სესიის ვადა შენახვისთვის მასალის განახლებამდე ამოიწურა.'
    ],
  'The content upgrade did not finish in time, and the editor session expired meanwhile.':
    [
      'Обновление материала не завершилось вовремя, а сессия редактора истекла.',
      'La actualización no terminó a tiempo y la sesión del editor caducó mientras tanto.',
      'მასალის განახლება დროულად ვერ დასრულდა და ამავე დროს რედაქტორის სესიის ვადა ამოიწურა.'
    ],
  'The editor did not answer the save request, and the editor session expired meanwhile.':
    [
      'Редактор не ответил на запрос сохранения, а его сессия истекла.',
      'El editor no respondió a la solicitud de guardado y su sesión caducó mientras tanto.',
      'რედაქტორმა შენახვის მოთხოვნას არ უპასუხა და ამავე დროს მისი სესიის ვადა ამოიწურა.'
    ],
  '{message} The save is repeated once the session is renewed; saving again does the same.':
    [
      '{message} Сохранение повторится после обновления сессии; повторное нажатие сохранения сделает то же самое.',
      '{message} El guardado se repetirá al renovar la sesión; volver a guardar hace lo mismo.',
      '{message} შენახვა სესიის განახლების შემდეგ განმეორდება; შენახვაზე ხელახლა დაჭერას იგივე შედეგი ექნება.'
    ],
  'Editor service request failed ({status}).': [
    'Запрос к сервису редактора завершился ошибкой ({status}).',
    'Falló la solicitud al servicio del editor ({status}).',
    'რედაქტორის სერვისის მოთხოვნა ვერ შესრულდა ({status}).'
  ],
  'The editor could not load its libraries ({reason}).': [
    'Редактор не смог загрузить библиотеки ({reason}).',
    'El editor no pudo cargar sus bibliotecas ({reason}).',
    'რედაქტორმა ბიბლიოთეკები ვერ ჩატვირთა ({reason}).'
  ],
  'network error': ['ошибка сети', 'error de red', 'ქსელის შეცდომა'],
  'unknown error': [
    'неизвестная ошибка',
    'error desconocido',
    'უცნობი შეცდომა'
  ],
  'Unknown error.': [
    'Неизвестная ошибка.',
    'Error desconocido.',
    'უცნობი შეცდომა.'
  ],
  'The content type to upgrade could not be read.': [
    'Не удалось определить тип материала для обновления.',
    'No se pudo leer el tipo de contenido que se va a actualizar.',
    'გასაახლებელი მასალის ტიპის წაკითხვა ვერ მოხერხდა.'
  ],
  'The parameters are broken.': [
    'Параметры повреждены.',
    'Los parámetros están dañados.',
    'პარამეტრები დაზიანებულია.'
  ],
  'The service returned an invalid media size check. Try the upload again.': [
    'Сервис вернул некорректный результат проверки размера файлов. Повторите загрузку.',
    'El servicio devolvió una comprobación de tamaño no válida. Vuelve a subir el archivo.',
    'სერვისმა ფაილების ზომის შემოწმების არასწორი შედეგი დააბრუნა. ხელახლა ატვირთეთ.'
  ],
  'The file exceeds the upload limit of {bytes} bytes. Choose a smaller file and retry.':
    [
      'Файл превышает ограничение загрузки в {bytes} байт. Выберите файл меньшего размера и повторите попытку.',
      'El archivo supera el límite de subida de {bytes} bytes. Elige uno más pequeño e inténtalo de nuevo.',
      'ფაილის ზომა ატვირთვის ზღვარს, {bytes} ბაიტს, აღემატება. აირჩიეთ პატარა ფაილი და სცადეთ ხელახლა.'
    ],
  'Failed to load {url}': [
    'Не удалось загрузить {url}',
    'No se pudo cargar {url}',
    '{url}-ის ჩატვირთვა ვერ მოხერხდა'
  ],
  'The content could not be upgraded before saving: {reason}': [
    'Не удалось обновить материал перед сохранением: {reason}',
    'No se pudo actualizar el contenido antes de guardarlo: {reason}',
    'შენახვამდე მასალის განახლება ვერ მოხერხდა: {reason}'
  ],
  'Cannot save: {reason}': [
    'Не удалось сохранить: {reason}',
    'No se puede guardar: {reason}',
    'შენახვა ვერ მოხერხდა: {reason}'
  ],
  'This content uses {library}. A newer version, {upgrade}, is installed. Upgrade to edit the content with it: your unsaved changes are kept, and nothing is stored until you save. Saving upgrades the content to the newer version in any case.':
    [
      'Материал использует {library}. Установлена новая версия {upgrade}. Обновите материал, чтобы редактировать его в этой версии: несохранённые изменения сохранятся в редакторе, а запись произойдёт только после сохранения. При сохранении материал в любом случае обновится до новой версии.',
      'El contenido usa {library}. Hay una versión más reciente instalada: {upgrade}. Actualízalo para editarlo con ella: los cambios sin guardar se conservan y nada se almacena hasta que guardes. Al guardar, el contenido se actualizará a la nueva versión en cualquier caso.',
      'მასალა იყენებს {library}-ს. დაყენებულია ახალი ვერსია, {upgrade}. განაახლეთ მასალა ამ ვერსიით რედაქტირებისთვის: შეუნახავი ცვლილებები რედაქტორში დარჩება, ხოლო მონაცემები მხოლოდ შენახვის შემდეგ ჩაიწერება. შენახვისას მასალა ნებისმიერ შემთხვევაში განახლდება ახალ ვერსიამდე.'
    ],
  'The content no longer uses {library}; there is nothing to upgrade.': [
    'Материал больше не использует {library}; обновлять нечего.',
    'El contenido ya no usa {library}; no hay nada que actualizar.',
    'მასალა აღარ იყენებს {library}-ს; გასაახლებელი არაფერია.'
  ],
  'The content could not be read from the editor: {reason}': [
    'Не удалось прочитать материал из редактора: {reason}',
    'No se pudo leer el contenido del editor: {reason}',
    'რედაქტორიდან მასალის წაკითხვა ვერ მოხერხდა: {reason}'
  ],
  'The editor was busy (a request or a reload) while the content was upgraded; try again once it has finished.':
    [
      'Во время обновления материала редактор выполнял запрос или перезагружался. Повторите попытку после завершения.',
      'El editor estaba ocupado con una solicitud o una recarga durante la actualización. Inténtalo de nuevo cuando termine.',
      'მასალის განახლებისას რედაქტორი მოთხოვნას ასრულებდა ან თავიდან იტვირთებოდა. დასრულების შემდეგ სცადეთ ხელახლა.'
    ],
  'The content could not be upgraded: {reason} It stays on {library} in the editor.':
    [
      'Не удалось обновить материал: {reason} В редакторе остаётся версия {library}.',
      'No se pudo actualizar el contenido: {reason} Permanece en {library} en el editor.',
      'მასალის განახლება ვერ მოხერხდა: {reason} რედაქტორში რჩება ვერსია {library}.'
    ],
  'The upgraded content could not be opened in the editor ({reason}). It was reopened on {library}.':
    [
      'Не удалось открыть обновлённый материал в редакторе ({reason}). Он повторно открыт в версии {library}.',
      'No se pudo abrir el contenido actualizado en el editor ({reason}). Se volvió a abrir con {library}.',
      'განახლებული მასალის რედაქტორში გახსნა ვერ მოხერხდა ({reason}). ის ხელახლა გაიხსნა ვერსიით {library}.'
    ],
  'Opening the content upgraded to {upgrade}…': [
    'Открытие материала, обновлённого до {upgrade}…',
    'Abriendo el contenido actualizado a {upgrade}…',
    '{upgrade}-მდე განახლებული მასალა იხსნება…'
  ],
  'The content was upgraded to {upgrade}. Save it to keep the upgrade. A save already waiting for session renewal will resume automatically.':
    [
      'Материал обновлён до {upgrade}. Сохраните его, чтобы записать обновление. Сохранение, ожидающее обновления сессии, продолжится автоматически.',
      'El contenido se actualizó a {upgrade}. Guárdalo para conservar la actualización. Un guardado pendiente de renovación de sesión se reanudará automáticamente.',
      'მასალა განახლდა ვერსიამდე {upgrade}. განახლების დასატოვებლად შეინახეთ. სესიის განახლების მომლოდინე შენახვა ავტომატურად გაგრძელდება.'
    ],
  '{library} — no newer version installed': [
    '{library} — новая версия не установлена',
    '{library} — no hay una versión más reciente instalada',
    '{library} — ახალი ვერსია დაყენებული არ არის'
  ],
  ' (no longer accepted by the installed content type)': [
    ' (больше не поддерживается установленным типом материала)',
    ' (el tipo de contenido instalado ya no la admite)',
    ' (დაყენებული მასალის ტიპი აღარ უჭერს მხარს)'
  ],
  'library versions that are not installed: {libraries}': [
    'неустановленные версии библиотек: {libraries}',
    'versiones de bibliotecas que no están instaladas: {libraries}',
    'ბიბლიოთეკების ვერსიები, რომლებიც დაყენებული არ არის: {libraries}'
  ],
  'library versions that the installed content types no longer accept: {libraries}':
    [
      'версии библиотек, которые больше не поддерживаются установленными типами материалов: {libraries}',
      'versiones de bibliotecas que los tipos de contenido instalados ya no admiten: {libraries}',
      'ბიბლიოთეკების ვერსიები, რომლებსაც დაყენებული მასალის ტიპები აღარ უჭერს მხარს: {libraries}'
    ],
  '; and ': ['; и ', '; y ', '; და '],
  'This content uses {libraries}. Upgrade it to the installed {upgrades} to edit it, or replace it with a package made for the installed libraries.':
    [
      'Материал использует {libraries}. Чтобы редактировать его, обновите до установленных {upgrades} или замените пакетом для установленных библиотек.',
      'El contenido usa {libraries}. Actualízalo a las versiones instaladas {upgrades} para editarlo o reemplázalo por un paquete compatible con las bibliotecas instaladas.',
      'მასალა იყენებს {libraries}. რედაქტირებისთვის განაახლეთ დაყენებულ {upgrades}-მდე ან ჩაანაცვლეთ დაყენებულ ბიბლიოთეკებთან თავსებადი პაკეტით.'
    ],
  'This content uses {libraries}. No newer installed version can replace them; replace the content with a package made for the installed libraries.':
    [
      'Материал использует {libraries}. Установленной новой версии для замены нет; замените материал пакетом для установленных библиотек.',
      'El contenido usa {libraries}. Ninguna versión más reciente instalada puede sustituirlas; reemplázalo por un paquete compatible con las bibliotecas instaladas.',
      'მასალა იყენებს {libraries}. მათ ჩასანაცვლებლად ახალი დაყენებული ვერსია არ არის; ჩაანაცვლეთ მასალა დაყენებულ ბიბლიოთეკებთან თავსებადი პაკეტით.'
    ],
  'The content could not be upgraded: {reason}': [
    'Не удалось обновить материал: {reason}',
    'No se pudo actualizar el contenido: {reason}',
    'მასალის განახლება ვერ მოხერხდა: {reason}'
  ],
  '{library} could not be replaced: an installed library accepts no newer version of it.':
    [
      'Не удалось заменить {library}: установленная библиотека не поддерживает её новые версии.',
      'No se pudo sustituir {library}: una biblioteca instalada no admite ninguna versión más reciente.',
      '{library}-ის ჩანაცვლება ვერ მოხერხდა: დაყენებული ბიბლიოთეკა მის ახალ ვერსიებს არ უჭერს მხარს.'
    ],
  'Could not load data for library {library}.': [
    'Не удалось загрузить данные библиотеки {library}.',
    'No se pudieron cargar los datos de la biblioteca {library}.',
    '{library} ბიბლიოთეკის მონაცემების ჩატვირთვა ვერ მოხერხდა.'
  ],
  'The upgrades script for {library} loaded, but the loaded H5P core does not support getUpgradeHooks.':
    [
      'Сценарий обновления {library} загружен, но загруженное ядро H5P не поддерживает getUpgradeHooks.',
      'Se cargó el script de actualización de {library}, pero el núcleo H5P cargado no admite getUpgradeHooks.',
      '{library}-ის განახლების სკრიპტი ჩაიტვირთა, მაგრამ ჩატვირთული H5P ბირთვი getUpgradeHooks-ს არ უჭერს მხარს.'
    ],
  'Could not load the upgrades script for {library}.': [
    'Не удалось загрузить сценарий обновления {library}.',
    'No se pudo cargar el script de actualización de {library}.',
    '{library}-ის განახლების სკრიპტის ჩატვირთვა ვერ მოხერხდა.'
  ],
  '{libraries} could not be replaced: the installed {target} accepts no installed version of it.':
    [
      'Не удалось заменить {libraries}: установленная {target} не поддерживает ни одну из установленных версий.',
      'No se pudo sustituir {libraries}: la biblioteca instalada {target} no admite ninguna versión instalada.',
      '{libraries}-ის ჩანაცვლება ვერ მოხერხდა: დაყენებული {target} არცერთ დაყენებულ ვერსიას არ უჭერს მხარს.'
    ],
  'Missing required library {library}.': [
    'Отсутствует необходимая библиотека {library}.',
    'Falta la biblioteca requerida {library}.',
    'საჭირო ბიბლიოთეკა {library} არ არის.'
  ],
  'The parameters contain {used} while only {supported} or earlier are supported.':
    [
      'Параметры содержат {used}, но поддерживается только {supported} или более ранняя версия.',
      'Los parámetros contienen {used}, pero solo se admite {supported} o una versión anterior.',
      'პარამეტრები შეიცავს {used}-ს, თუმცა მხარდაჭერილია მხოლოდ {supported} ან უფრო ძველი ვერსია.'
    ],
  'The parameters contain {used}, which is not supported.': [
    'Параметры содержат неподдерживаемую {used}.',
    'Los parámetros contienen {used}, que no es compatible.',
    'პარამეტრები შეიცავს {used}-ს, რომელიც მხარდაჭერილი არ არის.'
  ]
};

// Substitute once: error details and library names are literal text, even when
// they contain another placeholder or JavaScript replacement characters.
export function t(message, params = {}) {
  const index = ['ru', 'es', 'ka'].indexOf(language);
  const template = messages[message]?.[index] || message;
  return typeof template === 'string'
    ? template.replace(/\{(\w+)\}/g, (placeholder, key) =>
        Object.hasOwn(params, key) ? String(params[key]) : placeholder
      )
    : template;
}

export function setLanguage() {
  if (document.documentElement) document.documentElement.lang = language;
  document.title = t('Interactive Content Editor');
  const labels = {
    'host-loading': 'Loading editor…',
    'host-offer-upgrade': 'Upgrade',
    'host-offer-dismiss': 'Dismiss',
    'host-upgrade-reopen': 'Review the upgrade',
    'host-upgrade-close': 'Close',
    'host-upgrade-button': 'Upgrade',
    'host-license-link': 'Open-source licenses'
  };
  for (const [id, text] of Object.entries(labels)) {
    const element = document.getElementById(id);
    if (element) element.textContent = t(text);
  }
  document
    .getElementById('host-offer')
    ?.setAttribute('aria-label', t('Library upgrade'));
}

const localizedHtmlPrototypes = new WeakSet();

/** Keep editor chrome and rich-text controls separate from the book language. */
export function localizeEditorFrame(frame) {
  // H5P initially labels this document with metadata.defaultLanguage, even
  // when the interface is rendered in a different language.
  if (frame.document.documentElement)
    frame.document.documentElement.lang = language;
  const ns = frame.H5PEditor;
  const prototype = ns?.Html?.prototype;
  if (
    typeof prototype?.getCKEditorConfig !== 'function' ||
    localizedHtmlPrototypes.has(prototype)
  )
    return;
  localizedHtmlPrototypes.add(prototype);
  const getConfig = prototype.getCKEditorConfig;
  prototype.getCKEditorConfig = function (...args) {
    const config = getConfig.apply(this, args);
    config.language = {
      // The bundled editor has no Georgian dictionary. Keep its English
      // fallback without claiming the rich-text toolbar is in Georgian.
      ui: frame.CKEDITOR_TRANSLATIONS?.[language] ? language : 'en',
      content: ns.defaultLanguage || ns.contentLanguage || 'en'
    };
    return config;
  };
}
