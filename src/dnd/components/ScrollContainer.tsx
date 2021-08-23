import React from "react";
import classcat from "classcat";
import { Scrollable } from "./Scrollable";
import { useStoredScrollState } from "./ScrollStateContext";
import { c } from "src/components/helpers";

interface ScrollContainerProps {
  children?: React.ReactNode;
  className?: string;
  triggerTypes: string[];
  isStatic?: boolean;
  id: string;
  index?: number;
}

export function ScrollContainer({
  className,
  children,
  triggerTypes,
  isStatic,
  id,
  index,
}: ScrollContainerProps) {
  const { setRef, scrollRef } = useStoredScrollState(id, index);

  return (
    <div ref={setRef} className={classcat([className, c("scroll-container")])}>
      {isStatic ? (
        children
      ) : (
        <Scrollable scrollRef={scrollRef} triggerTypes={triggerTypes}>
          {children}
        </Scrollable>
      )}
    </div>
  );
}
