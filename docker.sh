#!/usr/bin/env bash
set -euo pipefail

export DH_PROJECT="openwebrxplus"
export DH_USERNAME="slechev"

# Local builds only. Published images are built and pushed exclusively by
# .github/workflows/docker-publish.yml; this script no longer pushes anything.

#IMAGES="${DH_PROJECT}-rtlsdr ${DH_PROJECT}-sdrplay ${DH_PROJECT}-hackrf ${DH_PROJECT}-airspy ${DH_PROJECT}-rtlsdr-soapy ${DH_PROJECT}-plutosdr ${DH_PROJECT}-limesdr ${DH_PROJECT}-soapyremote ${DH_PROJECT}-perseus ${DH_PROJECT}-fcdpp ${DH_PROJECT}-radioberry ${DH_PROJECT}-uhd ${DH_PROJECT}-rtltcp ${DH_PROJECT}-runds ${DH_PROJECT}-hpsdr ${DH_PROJECT}-bladerf ${DH_PROJECT}-full ${DH_PROJECT}"
IMAGES="${DH_PROJECT}-full"

ARCH=${ARCH:-$(uname -m)}
TAG=${TAG:-"latest"}
ARCHTAG="${TAG}-${ARCH}"
NIGHTLY_BUILD=$(date +%F)
CORES=$(cat /proc/cpuinfo | grep processor | wc -l)
MAKEFLAGS="${MAKEFLAGS:-"-j$CORES"}"

usage () {
  echo "Usage: ${0} [command]"
  echo "Available commands:"
  echo "  help       Show this usage information"
  echo "  buildn     Build full docker nightly image (current sources)"
  echo "  buildr     Build full docker release image (form Marat's apt repo)"
  echo
  echo "Environment variables:"
  echo "       ARCH - build for different architecture,        ex: ARCH=arm64 ${0} buildn"
  echo "        TAG - use different TAG (default is 'latest'), ex: TAG=mytag ${0} buildn"
  echo "  MAKEFLAGS - set MAKEFLAGS for the compiler,          ex: MAKEFLAGS='-j12' ${0} buildn"
}

buildn () {
  PLATFORM=""
  if [[ "${ARCH}" != "$(uname -m)" ]]; then
    PLATFORM="--platform=linux/$ARCH"
  fi

  echo -ne "\n\nBuilding the base image for $ARCH.\n\n"
  time docker build $PLATFORM \
    --build-arg MAKEFLAGS="$MAKEFLAGS" \
    -t ${DH_PROJECT}-base:${ARCHTAG} \
    --pull -f docker/Dockerfiles/Dockerfile-base .

  # NOTE: uncomment next 2 lines if you're building all images
  #echo -ne "\n\nBuilding soapysdr image.\n\n"
  #docker build $PLATFORM --build-arg ARCHTAG=${ARCHTAG} --build-arg PROJECT=${DH_PROJECT} --build-arg MAKEFLAGS="$MAKEFLAGS" -t ${DH_PROJECT}-soapysdr-base:${ARCHTAG} -f docker/Dockerfiles/Dockerfile-soapysdr .

  GIT_HASH=$(git rev-parse --short master)
  for image in ${IMAGES}; do
    i=$(echo ${image} | rev | cut -d- -f1 | rev)
    # "openwebrx" is a special image that gets tag-aliased later on
    if [[ ! -z "${i}" && "${i}" != "${DH_PROJECT}" ]] ; then
      echo -ne "\n\nBuilding ${i} image for $ARCH.\n\n"
      time docker build $PLATFORM \
        --build-arg GIT_HASH=${GIT_HASH} \
        --build-arg ARCHTAG=$ARCHTAG \
        --build-arg PROJECT=${DH_PROJECT} \
        --build-arg MAKEFLAGS="$MAKEFLAGS" \
        -t ${DH_USERNAME}/${image}:${ARCHTAG} \
        -f docker/Dockerfiles/Dockerfile-${i} .
    fi
  done

  # tag full image alias image
  docker tag ${DH_USERNAME}/${DH_PROJECT}-full:${ARCHTAG} ${DH_USERNAME}/${DH_PROJECT}-nightly:${NIGHTLY_BUILD}
  docker tag ${DH_USERNAME}/${DH_PROJECT}-full:${ARCHTAG} ${DH_USERNAME}/${DH_PROJECT}-nightly
}

buildr () {
  if [[ -z ${1:-} ]] ; then
    echo "Usage: ${0} buildr [version]"
    echo "NOTE: The version param will be used for tagging only."
    echo "The image will be built from the current packages in the apt-repo."
    echo; echo;
    return
  fi

  PLATFORM=""
  if [[ "${ARCH}" != "$(uname -m)" ]]; then
    PLATFORM="--platform=linux/$ARCH"
  fi

  echo -ne "\n\nBuilding release image for $ARCH: $1.\n\n"
	docker build $PLATFORM \
    --build-arg VERSION=$1 \
    --build-arg MAKEFLAGS="$MAKEFLAGS" \
    -t ${DH_USERNAME}/${DH_PROJECT}:${1}-${ARCH} \
    -t ${DH_USERNAME}/${DH_PROJECT}:${1} \
    -t ${DH_USERNAME}/${DH_PROJECT} \
    --pull -f docker/deb_based/Dockerfile .
}

dev () {
  if [[ -z ${1:-} ]] ; then
    echo "Usage: ${0} dev [ImageId]"; echo; echo;
    docker image ls
    return
  fi
  docker run --rm -it --entrypoint /bin/bash -p 8073:8073 --device /dev/bus/usb ${1}
}

run () {
  docker run --rm -it -p 8073:8073 --device /dev/bus/usb openwebrxplus-full:latest-${ARCH}
}

case ${1:-} in
  build) buildn ;; # alias for buildn
  buildn) buildn ;;
  buildr) buildr ${@:2} ;;
  dev) dev ${@:2} ;;
  run) run ;;
  *) usage ;;
esac
