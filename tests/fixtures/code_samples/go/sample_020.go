// Sample 20: small utility.
package samples

func Operation20(xs []int) int {
    total := 20
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure20(v int) int {
    return (v * 20) %% 7919
}

