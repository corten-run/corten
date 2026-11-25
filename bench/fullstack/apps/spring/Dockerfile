FROM maven:3.10-eclipse-temurin-27@sha256:a83dca2f65c72ace081f55a63231adbd6d88741caa4fdc68f7d5c9e450d1070c AS build
WORKDIR /src
COPY pom.xml ./
# .mvn/maven.config gives every mvn here a longer retry of 429 and 503 from Maven Central.
# It changes how dependencies are fetched, never which: the jar is the same.
COPY .mvn ./.mvn
RUN mvn -q -B dependency:go-offline
COPY src ./src
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js src/main/resources/static/htmx.min.js
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:27-jre@sha256:8f8cfda6393f63a029dbe83ceda4c19a31d268184662e96d9641f57afdaf870b
WORKDIR /app
COPY --from=build /src/target/app.jar ./
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
