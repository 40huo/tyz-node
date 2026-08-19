import { AlertDialog, Button } from "@heroui/react";
import { useEffect, useState } from "react";

type ConfirmRequest = { title: string; message: string; onConfirm: () => void };

// 模块级命令式调用；由挂载在应用根部的 <ConfirmDialog> 承接渲染
let showRequest: ((request: ConfirmRequest) => void) | null = null;

/** Standard destructive-action confirmation used across admin pages. */
export function confirmDanger(title: string, message: string, onConfirm: () => void) {
  showRequest?.({ title, message, onConfirm });
}

export function ConfirmDialog() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    showRequest = setRequest;
    return () => {
      showRequest = null;
    };
  }, []);

  return (
    <AlertDialog.Backdrop isOpen={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      <AlertDialog.Container>
        <AlertDialog.Dialog aria-label={request?.title ?? "确认操作"}>
          <AlertDialog.CloseTrigger />
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>{request?.title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm text-muted">{request?.message}</p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={() => setRequest(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                request?.onConfirm();
                setRequest(null);
              }}
            >
              确认
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
