def fetch_items() -> list:
    raise NotImplementedError


def masked_empty_list() -> list:
    try:
        return fetch_items()
    except Exception:
        # ruleid: py-silent-success-masking
        return []


def masked_none():
    try:
        return fetch_items()
    except ValueError as exc:
        print(exc)
        # ruleid: py-silent-success-masking
        return None


def masked_empty_dict() -> dict:
    try:
        return {"items": fetch_items()}
    except Exception:
        # ruleid: py-silent-success-masking
        return {}


def masked_empty_string() -> str:
    try:
        return str(fetch_items())
    except Exception:
        # ruleid: py-silent-success-masking
        return ""


def masked_dict_constructor() -> dict:
    try:
        return {"items": fetch_items()}
    except Exception:
        # ruleid: py-silent-success-masking
        return dict()


def masked_bare_except() -> list:
    try:
        return fetch_items()
    except:  # noqa: E722
        # ruleid: py-silent-success-masking
        return []


def ok_reraise() -> list:
    try:
        return fetch_items()
    except Exception as exc:
        print(exc)
        # ok: py-silent-success-masking
        raise


def ok_typed_raise() -> list:
    try:
        return fetch_items()
    except Exception as exc:
        # ok: py-silent-success-masking
        raise RuntimeError("fetch failed") from exc


def ok_meaningful_fallback() -> dict:
    try:
        return {"items": fetch_items()}
    except Exception:
        # ok: py-silent-success-masking
        return {"error": True}


def masked_with_finally() -> list:
    try:
        return fetch_items()
    except Exception:
        # ruleid: py-silent-success-masking
        return []
    finally:
        print("done")


def masked_multi_except():
    try:
        return fetch_items()
    except ValueError:
        # ruleid: py-silent-success-masking
        return []
    except KeyError:
        # ruleid: py-silent-success-masking
        return None


def masked_tuple_except() -> list:
    try:
        return fetch_items()
    except (KeyError, ValueError):
        # ruleid: py-silent-success-masking
        return []


def masked_tuple_except_with_finally():
    try:
        return fetch_items()
    except (KeyError, ValueError, TypeError):
        # ruleid: py-silent-success-masking
        return None
    finally:
        print("done")


def masked_with_else() -> list:
    try:
        items = fetch_items()
    except ValueError as exc:
        print(exc)
        # ruleid: py-silent-success-masking
        return []
    except (KeyError, TypeError):
        # ruleid: py-silent-success-masking
        return []
    else:
        return items


def masked_with_else_and_finally() -> list:
    try:
        items = fetch_items()
    except (KeyError, ValueError):
        # ruleid: py-silent-success-masking
        return []
    else:
        return items
    finally:
        print("done")


def ok_return_in_else() -> None:
    try:
        fetch_items()
    except (KeyError, ValueError) as exc:
        raise RuntimeError("fetch failed") from exc
    else:
        # ok: py-silent-success-masking
        return None


def masked_conditional_reraise(fatal: bool) -> list:
    try:
        return fetch_items()
    except Exception:
        if fatal:
            raise
        # ruleid: py-silent-success-masking
        return []


def ok_classify_then_reraise(fetch, is_not_found):
    try:
        return fetch()
    except Exception as exc:
        # ok: py-silent-success-masking
        if is_not_found(exc):
            return None
        raise


def ok_tuple_classify_then_reraise(fetch, is_not_found):
    try:
        return fetch()
    except (KeyError, ValueError) as exc:
        if is_not_found(exc):
            # ok: py-silent-success-masking
            return None
        raise


def ok_return_in_try_body(items: list) -> list:
    try:
        if not items:
            # ok: py-silent-success-masking
            return []
        return [i.strip() for i in items]
    except Exception as exc:
        raise RuntimeError("strip failed") from exc
