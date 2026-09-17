FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Keep the large Ragas/scientific dependency layer stable when only runner
# source changes, and install exactly the versions resolved in uv.lock.
COPY pyproject.toml uv.lock ./
RUN touch README.md \
    && pip install --no-cache-dir "setuptools>=75" "uv==0.11.7" \
    && uv export --locked --no-dev --no-emit-project --no-hashes -o /tmp/requirements.txt \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && pip uninstall -y uv \
    && rm -f /tmp/requirements.txt

COPY README.md ./README.md
COPY src ./src
RUN pip install --no-cache-dir --no-deps --no-build-isolation . \
    && useradd --create-home --uid 10001 evaluator

USER evaluator
ENTRYPOINT ["anydocs-ragas"]
