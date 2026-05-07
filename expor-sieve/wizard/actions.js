// actions.js — фабрика дефолтного действия для wizard-шаблонов.
// Вынесено из templates.js, чтобы templates.js можно было импортировать
// в Manager-е без подтаскивания внутренних зависимостей.
export function defaultAction(folders) {
  return { type: 'fileinto', folder: folders?.[0]?.path || '' };
}
