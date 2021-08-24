import { getDropDuration, transitions } from "../util/animation";
import { Axis, Entity, Hitbox } from "../types";
import { DndManager } from "./DndManager";
import { DragEventData } from "./DragManager";
import { getSiblingDirection, SiblingDirection } from "../util/path";
import { generateInstanceId } from "src/components/helpers";
import { getHitboxDimensions } from "../util/hitbox";

type EntityAndElement = [Entity, HTMLElement, HTMLElement];

interface Dimensions {
  width: number;
  height: number;
}

const emptyDimensions: Dimensions = {
  width: 0,
  height: 0,
};

export const dragLeaveDebounceLength = 100;

export class SortManager {
  dndManager: DndManager;
  sortables: Map<string, EntityAndElement>;
  shifted: Set<string>;
  hidden: Set<string>;
  isSorting: boolean;
  axis: Axis;
  placeholder: EntityAndElement | null;
  instanceId: string;

  sortListeners: Array<(isSorting: boolean) => void>;

  constructor(
    dndManager: DndManager,
    axis: Axis,
    onSortChange?: (isSorting: boolean) => void
  ) {
    this.instanceId = generateInstanceId();
    this.dndManager = dndManager;
    this.sortables = new Map();
    this.shifted = new Set();
    this.hidden = new Set();
    this.isSorting = false;
    this.axis = axis;
    this.placeholder = null;
    this.sortListeners = onSortChange ? [onSortChange] : [];

    dndManager.dragManager.emitter.on("dragStart", this.handleDragStart);
    dndManager.dragManager.emitter.on("dragEnd", this.handleDragEnd);
    dndManager.dragManager.emitter.on("dragEnter", this.handleDragEnter);
    dndManager.dragManager.emitter.on("dragLeave", this.handleDragLeave);
  }

  destroy() {
    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEndTimeout);

    this.dndManager.dragManager.emitter.off("dragStart", this.handleDragStart);
    this.dndManager.dragManager.emitter.off("dragEnd", this.handleDragEnd);
    this.dndManager.dragManager.emitter.off("dragEnter", this.handleDragEnter);
    this.dndManager.dragManager.emitter.off("dragLeave", this.handleDragLeave);
  }

  registerSortable(
    id: string,
    entity: Entity,
    el: HTMLElement,
    measureEl: HTMLElement
  ) {
    const isPlaceholder = entity.getData().type === "placeholder";

    this.sortables.set(id, [entity, el, measureEl]);

    if (isPlaceholder) {
      this.placeholder = [entity, el, measureEl];
      measureEl.dataset.axis = this.axis;
      measureEl.style.setProperty("transition", transitions.none);
    } else {
      el.style.setProperty("transition", transitions.none);
    }
  }

  unregisterSortable(id: string) {
    this.sortables.delete(id);
  }

  hitboxDimensions = emptyDimensions;

  handleDragStart = ({
    dragEntity,
    dragEntityMargin,
    dragOriginHitbox,
  }: DragEventData) => {
    const id = dragEntity?.entityId;
    const haveDragEntity = id ? this.sortables.has(id) : null;

    if (!dragEntity || !haveDragEntity || !dragOriginHitbox) {
      return;
    }

    this.setSortState(true);

    this.hitboxDimensions = getHitboxDimensions(
      dragOriginHitbox,
      dragEntityMargin
    );

    this.activatePlaceholder(this.hitboxDimensions, transitions.none);

    this.sortables.forEach(([entity, el, measureEl]) => {
      const siblingDirection = getSiblingDirection(
        dragEntity.getPath(),
        entity.getPath()
      );
      const entityId = entity.entityId;

      if (siblingDirection === SiblingDirection.Self) {
        this.hidden.add(entityId);
        return this.hideDraggingEntity(measureEl);
      }

      if (siblingDirection === SiblingDirection.After) {
        if (!this.shifted.has(entityId)) {
          this.shifted.add(entityId);
        }

        this.shiftEl(el, transitions.none, this.hitboxDimensions);
      }
    });
  };

  resetSelf({
    maintainHidden,
    shiftTransition,
    placeholderTransition,
  }: {
    maintainHidden: boolean;
    shiftTransition?: string;
    placeholderTransition?: string;
  }) {
    if (this.isSorting) {
      this.setSortState(false);
      this.deactivatePlaceholder(placeholderTransition);
    }

    if (this.shifted.size > 0) {
      this.shifted.forEach((entityId) => {
        if (this.sortables.has(entityId)) {
          const [, el] = this.sortables.get(entityId);
          this.resetEl(el, shiftTransition);
        }
      });

      this.shifted.clear();
    }

    if (!maintainHidden && this.hidden.size > 0) {
      this.hidden.forEach((entityId) => {
        if (this.sortables.has(entityId)) {
          const [, , measure] = this.sortables.get(entityId);
          this.resetEl(measure, shiftTransition);
        }
      });

      this.hidden.clear();
    }
  }

  private dragEndTimeout = 0;
  handleDragEnd = ({
    primaryIntersection,
    dragPosition,
    dragOriginHitbox,
    dragEntity,
  }: DragEventData) => {
    if (!this.isSorting || !dragPosition || !dragOriginHitbox || !dragEntity) {
      if (
        !primaryIntersection &&
        dragEntity &&
        this.sortables.has(dragEntity.entityId)
      ) {
        return this.resetSelf({ maintainHidden: false });
      }

      return this.resetSelf({ maintainHidden: true });
    }

    clearTimeout(this.dragEnterTimeout);
    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEndTimeout);

    const dropHitbox = primaryIntersection?.getHitbox() || dragOriginHitbox;
    const dropDuration = getDropDuration({
      position: dragPosition,
      destination: {
        x: dropHitbox[0],
        y: dropHitbox[1],
      },
    });

    this.dragEndTimeout = window.setTimeout(() => {
      if (
        primaryIntersection &&
        this.sortables.has(primaryIntersection.entityId) &&
        primaryIntersection.entityId !== dragEntity.entityId
      ) {
        this.dndManager.onDrop(dragEntity, primaryIntersection);
      }

      this.resetSelf({
        maintainHidden: false,
        shiftTransition: transitions.none,
        placeholderTransition: transitions.none,
      });
    }, dropDuration);

    this.hitboxDimensions = emptyDimensions;
  };

  private dragEnterTimeout = 0;
  handleDragEnter = ({
    dragEntity,
    dragEntityMargin,
    dragOriginHitbox,
    primaryIntersection,
  }: DragEventData) => {
    const id = primaryIntersection?.entityId;
    const haveSortable = id ? this.sortables.has(id) : null;

    if (
      !dragEntity ||
      !primaryIntersection ||
      !haveSortable ||
      !dragOriginHitbox
    ) {
      if (!haveSortable && this.isSorting) {
        this.resetSelf({ maintainHidden: true });
      }

      return;
    }

    if (dragEntity.entityId === primaryIntersection.entityId) {
      return;
    }

    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEnterTimeout);

    this.dragEnterTimeout = window.setTimeout(() => {
      this.setSortState(true);
      this.hitboxDimensions = getHitboxDimensions(
        dragOriginHitbox,
        dragEntityMargin
      );
      this.activatePlaceholder(this.hitboxDimensions, transitions.placeholder);
      this.sortables.forEach(([entity, el]) => {
        const siblingDirection = getSiblingDirection(
          primaryIntersection.getPath(),
          entity.getPath()
        );

        const entityId = entity.entityId;

        if (
          !this.hidden.has(entityId) &&
          (siblingDirection === SiblingDirection.Self ||
            siblingDirection === SiblingDirection.After)
        ) {
          if (!this.shifted.has(entityId)) {
            this.shifted.add(entityId);
            this.shiftEl(el, transitions.outOfTheWay, this.hitboxDimensions);
          }
        } else if (this.shifted.has(entityId)) {
          this.shifted.delete(entityId);
          this.resetEl(el);
        }
      });
    }, 10);
  };

  private dragLeaveTimeout = 0;
  handleDragLeave = () => {
    if (!this.isSorting) return;

    clearTimeout(this.dragLeaveTimeout);
    clearTimeout(this.dragEnterTimeout);
    this.dragLeaveTimeout = window.setTimeout(() => {
      this.resetSelf({ maintainHidden: true });
    }, dragLeaveDebounceLength);

    this.hitboxDimensions = emptyDimensions;
  };

  activatePlaceholder(
    dimensions: { width: number; height: number },
    transition: string
  ) {
    if (this.placeholder) {
      const isHorizontal = this.axis === "horizontal";
      const [, , measure] = this.placeholder;
      measure.style.setProperty("transition", transition);
      measure.style.setProperty(
        isHorizontal ? "width" : "height",
        `${isHorizontal ? dimensions.width : dimensions.height}px`
      );
    }
  }

  deactivatePlaceholder(transition: string = transitions.placeholder) {
    if (this.placeholder) {
      const [, , measure] = this.placeholder;
      measure.style.setProperty("transition", transition);
      measure.style.removeProperty("width");
      measure.style.removeProperty("height");
    }
  }

  hideDraggingEntity(el: HTMLElement) {
    el.style.setProperty("display", "none");
  }

  shiftEl(
    el: HTMLElement,
    transition: string,
    dimensions: { width: number; height: number }
  ) {
    el.style.setProperty("transition", transition);
    el.style.setProperty(
      "transform",
      this.axis === "horizontal"
        ? `translate3d(${dimensions.width}px, 0, 0)`
        : `translate3d(0, ${dimensions.height}px, 0)`
    );
  }

  resetEl(el: HTMLElement, transition: string = transitions.outOfTheWay) {
    el.style.setProperty("transition", transition);
    el.style.removeProperty("transform");
    el.style.removeProperty("display");
  }

  addSortNotifier(fn: (isSorting: boolean) => void) {
    this.sortListeners.push(fn);
  }

  removeSortNotifier(fn: (isSorting: boolean) => void) {
    this.sortListeners = this.sortListeners.filter(
      (listener) => listener !== fn
    );
  }

  setSortState(isSorting: boolean) {
    if (this.isSorting !== isSorting) {
      this.isSorting = isSorting;
      this.sortListeners.forEach((fn) => fn(isSorting));
    }
  }
}
