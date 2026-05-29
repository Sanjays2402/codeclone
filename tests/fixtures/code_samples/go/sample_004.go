// Sample 4: small utility.
package samples

func Operation4(xs []int) int {
    total := 4
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure4(v int) int {
    return (v * 4) %% 7919
}

