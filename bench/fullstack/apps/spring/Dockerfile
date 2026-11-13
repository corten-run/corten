FROM maven:3.9-eclipse-temurin-25 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -q -B dependency:go-offline
COPY src ./src
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js src/main/resources/static/htmx.min.js
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/target/app.jar ./
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
